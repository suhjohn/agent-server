import path from "node:path";
import { promisify } from "node:util";
import { exec as _exec } from "node:child_process";
import { AgentError } from "@/utils/errors";
import { isUnderWorkspace } from "./git";

const exec = promisify(_exec);

const BASE_WORKSPACE_PATH = "/home/appuser";

type GitRepoInfo = {
  name: string;
  path: string; // absolute
  relativePath: string; // relative to workspace
  isWorktree: boolean;
  root: string; // top-level root for the repo
  branch: string | null;
};

export async function listGitRepositories(): Promise<{
  repositories: GitRepoInfo[];
  count: number;
  timestamp: string;
}> {
  // Find both .git directories and files (worktrees have file .git with gitdir: ...)
  // Limit to the workspace to avoid scanning the whole system.
  // Use -xdev to avoid crossing filesystem boundaries and prune node_modules for speed.
  const findCmd = `find "${BASE_WORKSPACE_PATH}" -xdev -name .git \\( -type d -o -type f \\) -not -path '*/node_modules/*' -not -path '*/.venv/*' -not -path '*/.git/*' -prune 2>/dev/null | head -200`;

  const { stdout } = await exec(findCmd);
  const gitMarkers = stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);

  const parents = new Set<string>();
  for (const marker of gitMarkers) {
    const parent = path.dirname(marker);
    parents.add(parent);
  }

  const repos: GitRepoInfo[] = [];
  for (const repoPath of parents) {
    try {
      // Validate it's a git repo
      await exec(`git -C "${repoPath}" rev-parse --is-inside-work-tree`);
      const { stdout: topStdout } = await exec(
        `git -C "${repoPath}" rev-parse --show-toplevel`
      );
      const root = topStdout.trim() || repoPath;
      const { stdout: branchStdout } = await exec(
        `git -C "${repoPath}" rev-parse --abbrev-ref HEAD`
      );
      const branch = branchStdout.trim() || null;
      // If .git is a file at repoPath, it indicates a worktree usually.
      // More robust: compare repoPath vs top-level root.
      const isWorktree = path.resolve(repoPath) !== path.resolve(root);
      const relativePath = path.relative(BASE_WORKSPACE_PATH, repoPath) || "/";
      repos.push({
        name: path.basename(repoPath),
        path: repoPath,
        relativePath,
        isWorktree,
        root,
        branch,
      });
    } catch {
      // ignore non-repos
    }
  }

  // Sort: roots first, then worktrees, then alpha by name
  repos.sort((a, b) => {
    if (a.root !== b.root) return a.root.localeCompare(b.root);
    if (a.isWorktree !== b.isWorktree) return a.isWorktree ? 1 : -1;
    return a.path.localeCompare(b.path);
  });

  return {
    repositories: repos,
    count: repos.length,
    timestamp: new Date().toISOString(),
  };
}

export type DiffLine = {
  type: "context" | "add" | "del";
  content: string;
  oldLine?: number | null;
  newLine?: number | null;
};

export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type DiffFile = {
  oldPath: string | null;
  newPath: string;
  status:
    | "modified"
    | "added"
    | "deleted"
    | "renamed"
    | "copied"
    | "typechange";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
};

export async function getStructuredDiff(options: {
  repoPath: string; // absolute or relative to workspace
  base?: string; // default HEAD
  head?: string; // default working tree
  staged?: boolean; // true => diff --cached
  context?: number; // lines of context, default 3
}): Promise<{
  repoPath: string;
  relativePath: string;
  base: string | null;
  head: string | null;
  files: DiffFile[];
  timestamp: string;
}> {
  const abs = path.isAbsolute(options.repoPath)
    ? options.repoPath
    : path.join(BASE_WORKSPACE_PATH, options.repoPath);
  if (!isUnderWorkspace(abs)) {
    throw new AgentError("Path must be under workspace", 400);
  }

  // Build the git diff command
  const context = Number.isFinite(options.context) ? options.context : 3;
  const args: string[] = [
    `-C "${abs}"`,
    "diff",
    "--no-color",
    "--no-ext-diff",
    `-U${context}`,
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--patch",
    "--find-renames=90%",
  ];

  if (options.staged) {
    args.push("--cached");
  }

  const base = options.base ?? "HEAD";
  const head = options.head ?? (options.staged ? "" : "");
  // Range logic: if both base and head are provided, use base..head; if staged or working tree, just pass base
  if (options.head) {
    args.push(`${base}..${options.head}`);
  } else {
    args.push(base);
  }

  const cmd = `git ${args.join(" ")}`;
  const { stdout } = await exec(cmd);
  const diffText = stdout;

  const files = parseUnifiedDiff(diffText);

  // If showing working tree (no explicit head) and not limited to staged, also include untracked files as added
  if (!options.head && !options.staged) {
    try {
      const { stdout: untrackedStdout } = await exec(
        `git -C "${abs}" ls-files --others --exclude-standard`
      );
      const untracked = untrackedStdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      if (untracked.length > 0) {
        const contextArg = Number.isFinite(context) ? context : 3;
        // Build diffs for each untracked file using git --no-index against /dev/null
        const perFileDiffs = await Promise.all(
          untracked.map(async (rel) => {
            try {
              const { stdout: udiff } = await exec(
                `git -C "${abs}" diff --no-index --no-color --no-ext-diff -U${contextArg} --src-prefix=a/ --dst-prefix=b/ -- /dev/null "${rel}"`
              );
              return udiff as string;
            } catch (e: any) {
              // Even when differences are found, exit code is 0 for plain diff; but be defensive and recover stdout if present
              if (e && typeof e.stdout === "string") {
                return e.stdout as string;
              }
              return "";
            }
          })
        );

        for (const ud of perFileDiffs) {
          if (!ud) continue;
          const parsed = parseUnifiedDiff(ud);
          // Mark status as added explicitly in case parser didn't pick it up (e.g., unusual output)
          for (const f of parsed) {
            if (!f.status || f.status === "modified") {
              f.status = "added";
            }
          }
          files.push(...parsed);
        }
      }
    } catch {
      // Best-effort: ignore failures to list untracked files
    }
  }

  return {
    repoPath: abs,
    relativePath: path.relative(BASE_WORKSPACE_PATH, abs) || "/",
    base: options.base ?? "HEAD",
    head: options.head ?? null,
    files,
    timestamp: new Date().toISOString(),
  };
}

// Minimal unified diff parser sufficient for hunked rendering
function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;

  const nextFile = () => ({
    oldPath: null as string | null,
    newPath: "",
    status: "modified" as DiffFile["status"],
    additions: 0,
    deletions: 0,
    hunks: [] as DiffHunk[],
  });

  let current: DiffFile | null = null;
  while (i < lines.length) {
    const line = lines[i++];
    if (!line) continue;

    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      current = nextFile();
      continue;
    }

    if (!current) continue;

    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = line.slice("rename from ".length).trim();
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.newPath = line.slice("rename to ".length).trim();
      continue;
    }
    if (line.startsWith("new file mode ")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("index ")) {
      // ignore
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      current.oldPath = p.startsWith("a/") ? p.slice(2) : p;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      const newP = p.startsWith("b/") ? p.slice(2) : p;
      current.newPath = newP;
      continue;
    }
    if (line.startsWith("@@ ")) {
      // Hunk header: @@ -oldStart,oldLines +newStart,newLines @@
      const m =
        /@@ -(?<os>\d+)(,(?<ol>\d+))? \+(?<ns>\d+)(,(?<nl>\d+))? @@/.exec(line);
      if (!m || !m.groups || !current) continue;
      const oldStart = Number(m.groups["os"]);
      const oldLines = m.groups["ol"] ? Number(m.groups["ol"]) : 1;
      const newStart = Number(m.groups["ns"]);
      const newLines = m.groups["nl"] ? Number(m.groups["nl"]) : 1;
      const hunk: DiffHunk = {
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
      };

      let oldLineNo = oldStart;
      let newLineNo = newStart;
      // consume hunk body
      while (i < lines.length) {
        const l = lines[i];
        if (l === undefined) break;
        if (
          l.startsWith("diff --git ") ||
          l.startsWith("@@ ") ||
          l.startsWith("index ") ||
          l.startsWith("--- ") ||
          l.startsWith("+++ ") ||
          l.startsWith("rename ") ||
          l.startsWith("new file mode") ||
          l.startsWith("deleted file mode")
        ) {
          // new section
          break;
        }
        i++;
        if (!l.length) {
          hunk.lines.push({
            type: "context",
            content: "",
            oldLine: oldLineNo,
            newLine: newLineNo,
          });
          oldLineNo += 1;
          newLineNo += 1;
          continue;
        }
        const prefix = l[0];
        const content = l.slice(1);
        if (prefix === "+") {
          current.additions += 1;
          hunk.lines.push({
            type: "add",
            content,
            oldLine: null,
            newLine: newLineNo,
          });
          newLineNo += 1;
        } else if (prefix === "-") {
          current.deletions += 1;
          hunk.lines.push({
            type: "del",
            content,
            oldLine: oldLineNo,
            newLine: null,
          });
          oldLineNo += 1;
        } else if (prefix === " ") {
          hunk.lines.push({
            type: "context",
            content,
            oldLine: oldLineNo,
            newLine: newLineNo,
          });
          oldLineNo += 1;
          newLineNo += 1;
        } else if (prefix === "\\") {
          // '\ No newline at end of file'
          // attach as context
          hunk.lines.push({
            type: "context",
            content: l,
            oldLine: null,
            newLine: null,
          });
        } else {
          // unknown marker; end of hunk
          break;
        }
      }
      current.hunks.push(hunk);
      continue;
    }
  }
  if (current) files.push(current);
  return files;
}
