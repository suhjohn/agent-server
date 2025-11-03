import { promises as fs, constants as fsConstants } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

import {
  getAllSessions,
  getMessages,
  getSession,
  updateSessionName as updateSessionNameDb,
  deleteSession as deleteSessionDb,
  createSession,
} from "@/db/session";
import { redisClient, doneKey } from "@/redis";
import type { CreateSessionRequest } from "@/types/session";
import { AgentError } from "@/utils/errors";

const execAsync = promisify(exec);
const BASE_WORKSPACE_PATH = "/home/appuser";

const parsePositiveInteger = (
  rawValue: string | undefined,
  fallback: number
) => {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
};

const configuredMaxDepth = parsePositiveInteger(
  process.env.FILESYSTEM_MAX_DEPTH,
  30
);
const configuredDefaultDepth = parsePositiveInteger(
  process.env.FILESYSTEM_DEFAULT_DEPTH,
  10
);

const MAX_DIRECTORY_DEPTH = Math.max(1, configuredMaxDepth);
const DEFAULT_DIRECTORY_DEPTH = Math.min(
  configuredDefaultDepth,
  MAX_DIRECTORY_DEPTH
);
const gitRootCache = new Map<string, string | null>();
let fdAvailability: boolean | null = null;

const escapeShellArg = (value: string) =>
  `"${value.replace(/(["\\$`!])/g, "\\$1")}"`;

const escapeRegex = (value: string) =>
  value.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");

const isFdAvailable = async () => {
  if (fdAvailability !== null) {
    return fdAvailability;
  }

  try {
    await execAsync("command -v fd");
    fdAvailability = true;
  } catch {
    fdAvailability = false;
  }

  return fdAvailability;
};

export const listSessionsWithStreaming = async () => {
  const sessions = await getAllSessions();

  const sessionsWithStreaming = await Promise.all(
    sessions.map(async (session) => {
      const isActive = await redisClient.get(`session:active:${session.id}`);

      return {
        ...session,
        isStreaming: !!isActive,
      };
    })
  );

  return {
    sessions: sessionsWithStreaming,
    count: sessionsWithStreaming.length,
    timestamp: new Date().toISOString(),
  };
};

const ensureSessionExists = async (sessionId: string) => {
  const session = await getSession(sessionId);
  if (!session) {
    throw new AgentError("Session not found", 404);
  }
  return session;
};

export const getSessionMessagesResponse = async (sessionId: string) => {
  await ensureSessionExists(sessionId);
  const messages = await getMessages(sessionId);

  return {
    sessionId,
    messages,
    count: messages.length,
    timestamp: new Date().toISOString(),
  };
};

export const createSessionRecord = async (input: CreateSessionRequest) => {
  return createSession(input);
};

export const updateSessionNameResponse = async (
  sessionId: string,
  name: string
) => {
  await ensureSessionExists(sessionId);
  return await updateSessionNameDb(sessionId, name);
};

export const deleteSessionById = async (sessionId: string) => {
  await ensureSessionExists(sessionId);
  await deleteSessionDb(sessionId);

  try {
    await redisClient.del(`session:active:${sessionId}`, doneKey(sessionId));
  } catch (error) {
    console.warn("Failed to delete Redis keys for session", sessionId, error);
  }

  return {
    deleted: true,
    sessionId,
    timestamp: new Date().toISOString(),
  };
};

interface FilesystemOptions {
  path?: string;
  includeFiles?: boolean;
  maxDepth?: number;
}

interface UploadedFileDescriptor {
  originalname: string;
  buffer?: Buffer;
  size?: number;
}

interface UploadFilesOptions {
  path?: string;
  files: UploadedFileDescriptor[];
}

const normalizeTargetPathInput = (targetPath: string | undefined): string => {
  if (!targetPath) {
    return "";
  }

  const trimmed = targetPath.trim();
  if (!trimmed || trimmed === "~" || trimmed === "~/") {
    return "";
  }

  const withoutHomePrefix = trimmed.startsWith("~/")
    ? trimmed.slice(2)
    : trimmed.startsWith("~")
    ? trimmed.slice(1)
    : trimmed;

  return withoutHomePrefix.replace(/^\/+/, "");
};

const resolveTargetPath = (targetPath: string | undefined) => {
  const normalizedTarget = normalizeTargetPathInput(targetPath);
  if (!normalizedTarget) {
    return {
      target: "",
      fullPath: BASE_WORKSPACE_PATH,
    };
  }

  const resolvedPath = path.resolve(BASE_WORKSPACE_PATH, normalizedTarget);
  if (!resolvedPath.startsWith(BASE_WORKSPACE_PATH)) {
    throw new AgentError("Path must be within /home/appuser", 400);
  }

  return {
    target: normalizedTarget,
    fullPath: resolvedPath,
  };
};

const sanitizeRelativePath = (filePath: string) => {
  const normalized = filePath.replace(/\\+/g, "/").replace(/^\/+/, "");
  const segments = normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..");

  if (!segments.length) {
    return null;
  }

  return segments.join("/");
};

const findGitRootFromDirectory = async (
  directory: string
): Promise<string | null> => {
  let current = directory;
  const visited: string[] = [];

  while (current.startsWith(BASE_WORKSPACE_PATH)) {
    if (gitRootCache.has(current)) {
      const cached = gitRootCache.get(current) ?? null;
      visited.forEach((dir) => gitRootCache.set(dir, cached));
      return cached;
    }

    const gitDir = path.join(current, ".git");

    try {
      await fs.access(gitDir, fsConstants.F_OK);
      gitRootCache.set(current, current);
      visited.forEach((dir) => gitRootCache.set(dir, current));
      return current;
    } catch {
      // no .git directory at this level, continue upwards
    }

    visited.push(current);
    const parent = path.dirname(current);

    if (parent === current || !parent.startsWith(BASE_WORKSPACE_PATH)) {
      break;
    }

    current = parent;
  }

  visited.forEach((dir) => gitRootCache.set(dir, null));
  gitRootCache.set(directory, null);

  return null;
};

const findGitRootForPath = async (
  absolutePath: string,
  isDirectory: boolean
): Promise<string | null> => {
  if (gitRootCache.has(absolutePath)) {
    return gitRootCache.get(absolutePath) ?? null;
  }

  const startDir = isDirectory ? absolutePath : path.dirname(absolutePath);
  if (!startDir.startsWith(BASE_WORKSPACE_PATH)) {
    gitRootCache.set(absolutePath, null);
    return null;
  }

  const gitRoot = await findGitRootFromDirectory(startDir);
  gitRootCache.set(absolutePath, gitRoot);
  return gitRoot;
};

const getWorktreeInfo = async (
  directory: string
): Promise<{ isWorktree: boolean; worktreeDir: string | null }> => {
  // Find the actual git root from this directory
  const gitRoot = await findGitRootFromDirectory(directory);
  if (!gitRoot) {
    return { isWorktree: false, worktreeDir: null }; // Not in a repo at all
  }

  // Check if the git root's .git is a file (= worktree) or directory (= main repo)
  const gitPath = path.join(gitRoot, ".git");
  try {
    const stats = await fs.stat(gitPath);
    if (stats.isFile()) {
      // If .git is a file, we're in a worktree
      // Extract the worktree directory name (e.g., "sess_abc123" from ".../worktrees/sess_abc123")
      const worktreeDir = path.basename(gitRoot);
      return { isWorktree: true, worktreeDir };
    }
    return { isWorktree: false, worktreeDir: null };
  } catch {
    return { isWorktree: false, worktreeDir: null };
  }
};

const isSubsequence = (needle: string, haystack: string) => {
  if (!needle) return true;
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) {
      index += 1;
      if (index === needle.length) {
        return true;
      }
    }
  }
  return false;
};

export const getFilesystemDirectories = async ({
  path: targetPath,
  includeFiles = false,
  maxDepth,
}: FilesystemOptions) => {
  const requestedDepth =
    typeof maxDepth === "number" && Number.isFinite(maxDepth)
      ? maxDepth
      : DEFAULT_DIRECTORY_DEPTH;
  const depth = Math.min(Math.max(requestedDepth, 1), MAX_DIRECTORY_DEPTH);

  const rawSearch = targetPath?.trim() ?? "";
  const searchTokens = rawSearch.length
    ? rawSearch
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [];

  const runFdSearch = async (): Promise<string[]> => {
    const normalizedTokens = searchTokens.map((token) => escapeRegex(token));
    const fdPattern =
      normalizedTokens.length > 0 ? normalizedTokens.join(".*") : ".*";
    const fdArgs: string[] = [
      "fd",
      "--absolute-path",
      "--full-path",
      "--ignore-case",
      "--hidden",
      "--no-ignore",
      "--follow",
      "--color",
      "never",
      "--max-depth",
      depth.toString(),
      "--max-results",
      "400",
      "--print0",
    ];

    if (!includeFiles) {
      fdArgs.push("--type", "d");
    }

    fdArgs.push(fdPattern);
    fdArgs.push(BASE_WORKSPACE_PATH);

    const command = fdArgs.map(escapeShellArg).join(" ");
    const { stdout } = await execAsync(command);
    return stdout
      .split("\0")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  };

  if (!(await isFdAvailable())) {
    throw new AgentError(
      "Filesystem search requires the `fd` command to be installed",
      500
    );
  }

  let candidatePaths: string[] = [];
  try {
    candidatePaths = await runFdSearch();
  } catch (error) {
    throw new AgentError("Failed to execute fd search", 500, error as Error);
  }

  candidatePaths = candidatePaths.filter((absolutePath) => {
    const relativeCandidate = path.relative(BASE_WORKSPACE_PATH, absolutePath);
    if (
      relativeCandidate.startsWith("..") ||
      path.isAbsolute(relativeCandidate)
    ) {
      return false;
    }
    if (relativeCandidate === ".git") {
      return false;
    }
    return !relativeCandidate.includes("/.git/");
  });

  const matchedPaths = candidatePaths
    .map((absolutePath) => {
      const relativePath = path.relative(BASE_WORKSPACE_PATH, absolutePath);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return null;
      }
      return { absolutePath, relativePath };
    })
    .filter(
      (
        entry
      ): entry is {
        absolutePath: string;
        relativePath: string;
      } => entry !== null
    )
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .slice(0, 200);

  const entries = await Promise.all(
    matchedPaths.map(async ({ absolutePath, relativePath }) => {
      try {
        const stats = await fs.stat(absolutePath);

        if (!includeFiles && !stats.isDirectory()) {
          return null;
        }

        const name = relativePath.split("/").pop() ?? relativePath;

        const gitRootAbsolute = await findGitRootForPath(
          absolutePath,
          stats.isDirectory()
        );
        const gitRootRelative = gitRootAbsolute
          ? path.relative(BASE_WORKSPACE_PATH, gitRootAbsolute) || "/"
          : null;

        return {
          name,
          type: stats.isFile() ? "file" : "directory",
          path: relativePath,
          inGitRepo: gitRootAbsolute !== null,
          gitRoot: gitRootRelative,
        } as const;
      } catch {
        return null;
      }
    })
  );

  const validEntries = entries
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .filter((entry) => entry.type === "directory" || includeFiles);

  let currentGitRootAbsolute: string | null = null;
  let currentGitRootRelative: string | null = null;

  let worktreeInfo: { isWorktree: boolean; worktreeDir: string | null } = {
    isWorktree: false,
    worktreeDir: null,
  };

  if (targetPath && targetPath.trim().length > 0) {
    try {
      const { fullPath } = resolveTargetPath(targetPath);

      let inspectionPath = fullPath;
      let stats: Awaited<ReturnType<typeof fs.stat>> | null = null;

      // Walk up until we find an existing path within the workspace.
      while (inspectionPath.startsWith(BASE_WORKSPACE_PATH)) {
        try {
          stats = await fs.stat(inspectionPath);
          break;
        } catch {
          const parent = path.dirname(inspectionPath);
          if (parent === inspectionPath) {
            break;
          }
          inspectionPath = parent;
        }
      }

      if (stats) {
        const isDirectory = stats.isDirectory();
        currentGitRootAbsolute = await findGitRootForPath(
          inspectionPath,
          isDirectory
        );
        currentGitRootRelative = currentGitRootAbsolute
          ? path.relative(BASE_WORKSPACE_PATH, currentGitRootAbsolute) || "/"
          : null;

        const worktreeTargetDir = isDirectory
          ? inspectionPath
          : path.dirname(inspectionPath);
        if (currentGitRootAbsolute) {
          worktreeInfo = await getWorktreeInfo(currentGitRootAbsolute);
        } else if (worktreeTargetDir.startsWith(BASE_WORKSPACE_PATH)) {
          worktreeInfo = await getWorktreeInfo(worktreeTargetDir);
        }
      }
    } catch {
      // Ignore invalid target paths; fall back to defaults.
    }
  }

  return {
    path: targetPath,
    fullPath: targetPath
      ? path.resolve(BASE_WORKSPACE_PATH, targetPath)
      : BASE_WORKSPACE_PATH,
    entries: validEntries,
    count: validEntries.length,
    maxDepth: depth,
    currentInGitRepo: Boolean(targetPath && currentGitRootAbsolute !== null),
    currentGitRoot: targetPath ? currentGitRootRelative : null,
    currentIsWorktree: targetPath ? worktreeInfo.isWorktree : false,
    currentWorktreeDir: targetPath ? worktreeInfo.worktreeDir : null,
    timestamp: new Date().toISOString(),
  };
};

export const uploadFilesToFilesystem = async ({
  path: targetPath,
  files,
}: UploadFilesOptions) => {
  if (!files?.length) {
    throw new AgentError("No files provided for upload", 400);
  }

  const { target, fullPath } = resolveTargetPath(targetPath);
  await fs.mkdir(fullPath, { recursive: true });

  const uploaded: {
    path: string;
    bytes: number;
  }[] = [];

  let skipped = 0;

  for (const file of files) {
    const { originalname, buffer } = file;
    if (!buffer || !buffer.length) {
      skipped += 1;
      continue;
    }

    const safeRelativePath = sanitizeRelativePath(originalname);
    if (!safeRelativePath) {
      skipped += 1;
      continue;
    }

    const destination = path.join(fullPath, safeRelativePath);
    if (!destination.startsWith(fullPath)) {
      skipped += 1;
      continue;
    }

    const destinationDirectory = path.dirname(destination);
    await fs.mkdir(destinationDirectory, { recursive: true });
    await fs.writeFile(destination, buffer);

    uploaded.push({
      path: target ? path.join(target, safeRelativePath) : safeRelativePath,
      bytes: buffer.length,
    });
  }

  if (uploaded.length === 0) {
    throw new AgentError("Failed to store uploaded files", 500);
  }

  return {
    path: target ?? "",
    uploadedCount: uploaded.length,
    skippedCount: skipped,
    files: uploaded,
    timestamp: new Date().toISOString(),
  };
};
