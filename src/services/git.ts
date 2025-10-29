import { promisify } from "node:util";
import { exec as _exec } from "node:child_process";
import path from "node:path";
import os from "node:os";

const exec = promisify(_exec);

// Keep consistent with sessionService assumptions
const BASE_WORKSPACE_PATH = "/home/appuser";

export async function getGitRoot(dir: string): Promise<string | null> {
  try {
    const { stdout } = await exec(`git -C "${dir}" rev-parse --show-toplevel`);
    const top = stdout.trim();
    if (!top) return null;
    return top;
  } catch {
    return null;
  }
}

export async function createWorktree(options: {
  gitRoot: string;
  sessionId: string;
}): Promise<{ worktreePath: string; branch: string }> {
  const { gitRoot, sessionId } = options;
  const shortId = (sessionId.split("-")?.[0] || sessionId).toLowerCase();
  const repoName = path.basename(gitRoot).replace(/\s+/g, "-");
  const baseWorktrees = path.join(BASE_WORKSPACE_PATH, ".worktrees", repoName);
  const worktreePath = path.join(baseWorktrees, shortId);
  const branchBase = `session/${shortId}`;

  // Ensure base directory exists
  await exec(`mkdir -p "${baseWorktrees}"`);

  // Choose a unique branch name if needed
  let branch = branchBase;
  let counter = 0;
  // Check if branch exists
  // git -C <root> rev-parse --verify --quiet <branch>
  // If exists, append -<n>
  // Cap attempts to avoid infinite loop
  while (counter < 10) {
    try {
      await exec(`git -C "${gitRoot}" rev-parse --verify --quiet "${branch}"`);
      counter += 1;
      branch = `${branchBase}-${counter}`;
    } catch {
      // rev-parse failed -> branch does not exist
      break;
    }
  }

  // Add worktree with new branch
  await exec(
    `git -C "${gitRoot}" worktree add -b "${branch}" "${worktreePath}"`
  );

  return { worktreePath, branch };
}

export function isUnderWorkspace(fullPath: string): boolean {
  const normalized = path.resolve(fullPath);
  return (
    normalized === BASE_WORKSPACE_PATH ||
    normalized.startsWith(path.join(BASE_WORKSPACE_PATH, path.sep))
  );
}
