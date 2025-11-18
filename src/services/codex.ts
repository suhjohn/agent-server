/**
 * https://github.com/openai/codex/blob/main/docs/config.md
 * Calls `codex <prompt> <flags based on the markdown file format>`
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

type CodexOptions = {
  cwd: string;
  model: string;
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
  modelReasoningEffort: "low" | "medium" | "high";
  resume?: string | undefined; // -> resume <resume>
  images?: string[] | undefined; // -> --image <comma-separated-paths>
  mcpServers: Record<string, unknown>; // reserved for future use
};

type CodexStreamEvent =
  | { type: "init"; session_file_path: string; session_id: string }
  | { type: "done" };

function buildCodexArgs(prompt: string, opts: CodexOptions): string[] {
  const args: string[] = [];

  // Force non-interactive execution to avoid TTY requirements
  args.push("exec", "--skip-git-repo-check");
  args.push("--yolo");

  if (opts.resume) {
    args.push("resume", opts.resume);
  }

  // Prepend image paths to the prompt if provided
  let fullPrompt = prompt;
  if (opts.images && opts.images.length > 0) {
    const imagePaths = opts.images.join("\n");
    fullPrompt = `${imagePaths}\n\n${prompt}`;
  }

  // Sanitize prompt: replace double quotes with Unicode quotation marks
  // to avoid shell parsing issues while maintaining readability
  const sanitizedPrompt = fullPrompt.replace(/"/g, '"');

  // Prompt as the primary argument
  args.push(`${sanitizedPrompt}`);

  // Map options to -c overrides (best effort based on available docs)
  if (opts.model) {
    args.push("-c", `model=${opts.model}`);
  }

  if (opts.approvalPolicy) {
    // Many CLIs use snake_case config keys; use a conservative name
    args.push("-c", `approval_policy=${opts.approvalPolicy}`);
  }

  if (opts.modelReasoningEffort) {
    args.push("-c", `model_reasoning_effort=${opts.modelReasoningEffort}`);
  } else if (opts.model.includes("gpt-5")) {
    args.push("-c", `model_reasoning_effort=high`);
  }

  return args;
}

// Extract the UUID segment from a Codex session jsonl filename
function extractUuidFromJsonlPath(p: string): string | null {
  const m = path
    .basename(p)
    .match(
      /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(?<uuid>[0-9a-fA-F-]{36})\.jsonl$/
    );
  const uuid = (m?.groups as { uuid?: string } | undefined)?.uuid ?? null;
  return uuid;
}

// Parse a line like: "session id: 0199ea78-389d-7dc0-a2b9-a41cf7c8b782"
function parseSessionId(text: string): string | null {
  const m = text.match(/session id:\s*([0-9a-fA-F-]{36})/i);
  if (m && typeof m[1] === "string" && m[1].length > 0) {
    return m[1];
  }
  return null;
}

/**
 * Recursively search ~/.codex/sessions for a session jsonl file whose filename
 * contains the given UUID. Returns the most recently modified matching file,
 * or null if none found.
 */
export async function findCodexSessionFileById(
  sessionId: string
): Promise<string | null> {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const lowerId = sessionId.toLowerCase();

  type Match = { filePath: string; mtimeMs: number };
  const matches: Match[] = [];

  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".jsonl")) continue;
      if (!entry.name.startsWith("rollout-")) continue;

      const uuid = extractUuidFromJsonlPath(fullPath);
      if (!uuid) continue;
      if (uuid.toLowerCase() !== lowerId) continue;

      try {
        const stat = await fs.stat(fullPath);
        matches.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
      } catch {
        matches.push({ filePath: fullPath, mtimeMs: 0 });
      }
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]!.filePath;
}

// Poll until a session file containing the given UUID appears or timeout/abort occurs
async function waitForSessionFileById(
  sessionId: string,
  options?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal }
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const intervalMs = options?.intervalMs ?? 250;
  const signal = options?.signal;

  // Quick immediate check first
  const immediate = await findCodexSessionFileById(sessionId);
  if (immediate) return immediate;

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(timeout);
      reject(new Error("Aborted while waiting for Codex session file by id"));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort);
    }

    const check = async () => {
      try {
        const found = await findCodexSessionFileById(sessionId);
        if (found) {
          if (settled) return;
          settled = true;
          clearInterval(timer);
          clearTimeout(timeout);
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve(found);
        }
      } catch (err) {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    };

    const timer = setInterval(check, intervalMs);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(new Error("Timed out waiting for Codex session file by id"));
    }, timeoutMs + 5);
  });
}

/**
 * Spawn the "codex" CLI and yield structured events for the session file.
 *
 * Steps:
 * 1) Spawn the `codex` process (stderr forwarded to console; abort supported).
 * 2) Read stdout until the first header line with a UTC timestamp like
 *    "[YYYY-MM-DDTHH:MM:SS] ..." appears.
 * 3) Convert that UTC timestamp to LOCAL OS time via Date getters
 *    (getFullYear/getMonth/getDate/getHours/getMinutes/getSeconds).
 * 4) Build the expected sessions directory and filename prefix from local time:
 *    - Dir: ${homedir()}/.codex/sessions/YYYY/MM/DD
 *    - Prefix: rollout-YYYY-MM-DDTHH-mm-ss-
 * 5) Do a single directory read to find a `.jsonl` that starts with the prefix
 *    (no polling).
 * 6) If found, yield one init event: { type: "init", session_file_path }.
 * 7) When the process exits successfully, yield { type: "done" }.
 *    If it exits non-zero, throw an error.
 * 8) On abort, attempt to terminate the child and end early.
 */
export async function* queryCodex({
  prompt,
  abortController,
  options,
}: {
  prompt: string;
  abortController: AbortController;
  options: CodexOptions;
}): AsyncGenerator<CodexStreamEvent> {
  if (!prompt || typeof prompt !== "string") {
    throw new Error("prompt is required");
  }
  if (!options || typeof options !== "object") {
    throw new Error("options are required");
  }

  const args = buildCodexArgs(prompt, options);

  // Run codex as a normal async subprocess (non-interactive)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
  };
  console.log(`codex ${args.join(" ")}`);
  const child = spawn("codex", args, {
    cwd: options.cwd || process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  let aborted = false;
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    try {
      child.kill("SIGTERM");
      // Fallback hard kill if it doesn't exit shortly
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 3000).unref();
    } catch {
      // noop
    }
  };
  abortController.signal.addEventListener("abort", onAbort);

  // Forward stderr to logs (do not break the output stream contract)
  child.stderr?.setEncoding("utf8");

  // Bubble up spawn errors early
  const spawnError: Promise<never> = new Promise((_, reject) => {
    child.on("error", (err) => reject(err));
  });

  // Stream stdout chunks (we don't parse stdout anymore)
  child.stdout?.setEncoding("utf8");

  try {
    // race spawn error with normal streaming
    let emittedPath = false;
    // Queue to bridge background finder to generator output
    const pendingEmits: CodexStreamEvent[] = [];

    // Setup stderr parsing now that shared state is defined
    let stderrBuffer = "";
    let sessionIdFound: string | null = null;
    child.stderr?.on("data", (chunk) => {
      const data = typeof chunk === "string" ? chunk : String(chunk);
      if (data.trim().length > 0) {
        console.error(`[codex stderr] ${data}`);
      }
      if (!options.resume && !sessionIdFound) {
        stderrBuffer += data;
        const maybeId = parseSessionId(stderrBuffer);
        if (maybeId) {
          sessionIdFound = maybeId;
          // Begin waiting for any session file that includes this UUID
          waitForSessionFileById(sessionIdFound, {
            timeoutMs: 60_000,
            intervalMs: 250,
            signal: abortController.signal,
          })
            .then((found) => {
              if (!emittedPath) {
                emittedPath = true;
                console.log({
                  found,
                  uuid: sessionIdFound,
                });
                pendingEmits.push({
                  type: "init",
                  session_file_path: found,
                  session_id: sessionIdFound!,
                });
              }
            })
            .catch((err) => {
              console.error(String(err?.message ?? err));
            });
        }
      }
    });

    const streaming = (async () => {
      for await (const _chunk of child.stdout!) {
        if (abortController.signal.aborted) break;
        // no-op; we no longer parse stdout
      }
    })();

    // Merge race: if spawnError rejects first, throw; otherwise stream
    let spawnFailed = false;
    await Promise.race([
      spawnError.catch((e) => {
        spawnFailed = true;
        throw e;
      }),
      new Promise<void>((resolve) => child.once("spawn", () => resolve())),
    ]);
    if (spawnFailed) return; // type guard

    // Drain background parsing while process runs
    while (true) {
      // Flush any pending emits (e.g., discovered file path)
      while (pendingEmits.length) {
        const next = pendingEmits.shift();
        if (next !== undefined) yield next;
      }
      const exited = await Promise.race([
        streaming.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      if (exited) break;
    }

    // Wait for process to exit to surface non-zero codes
    const exitCode: number = await new Promise((resolve) => {
      child.once("close", (code) => resolve(code ?? 0));
    });
    if (!aborted && exitCode !== 0) {
      throw new Error(`codex exited with code ${exitCode}`);
    }
    // On successful completion, emit done sentinel
    if (!aborted) {
      yield { type: "done" };
    }
  } finally {
    abortController.signal.removeEventListener("abort", onAbort);
    try {
      if (!child.killed) child.kill("SIGTERM");
    } catch {
      // noop
    }
  }
}

/**
 * Tail a JSONL file and yield newly appended lines as UTF-8 strings.
 *
 * - Starts from end-of-file by default (only new lines). Set startAtEnd=false to replay from start.
 * - Uses low-frequency polling (default 150ms) for portability across filesystems/containers.
 * - Aborts cleanly via AbortSignal.
 */
export async function* tailJsonlFile(
  filePath: string,
  options?: { signal?: AbortSignal; startAtEnd?: boolean }
): AsyncGenerator<string> {
  const signal = options?.signal;
  const startAtEnd = options?.startAtEnd ?? true;

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    if (notify) {
      notify();
      notify = null;
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort);
  }

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);

  // Simple async queue to bridge watcher events to the generator
  const queue: string[] = [];
  let notify: (() => void) | null = null;
  const enqueue = (line: string) => {
    queue.push(line);
    if (notify) {
      notify();
      notify = null;
    }
  };

  let handle: FileHandle | null = null;
  let offset = 0;
  let pending = "";
  // Prevent overlapping reads when multiple fs.watch events arrive rapidly
  let reading = false;
  let readQueued = false;

  const openIfNeeded = async (initial: boolean) => {
    if (handle) return;
    try {
      handle = await fs.open(filePath, "r");
      const stat = await handle.stat();
      offset = initial ? (startAtEnd ? stat.size : 0) : 0;
    } catch (err: any) {
      if (err && err.code === "ENOENT") {
        // Not created yet; wait for watcher rename event
        return;
      }
      throw err;
    }
  };

  const readNew = async () => {
    if (reading) {
      // Coalesce multiple change events into a single subsequent read
      readQueued = true;
      return;
    }
    reading = true;
    try {
      if (!handle) {
        await openIfNeeded(false);
        if (!handle) return;
      }
      let stat: fsSync.Stats;
      try {
        stat = await fs.stat(filePath);
      } catch (err: any) {
        if (err && err.code === "ENOENT") {
          // File disappeared (rotation). Reset and wait for rename to reopen
          try {
            const fh = handle;
            if (fh) await fh.close();
          } catch {}
          handle = null;
          offset = 0;
          pending = "";
          return;
        }
        throw err;
      }
      if (stat.size <= offset) return;

      const toRead = stat.size - offset;
      const buffer = Buffer.allocUnsafe(Math.min(toRead, 1 << 20));
      let position = offset;
      let remaining = toRead;
      while (remaining > 0 && !aborted) {
        const chunkSize = Math.min(buffer.length, remaining);
        const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
        if (bytesRead <= 0) break;
        position += bytesRead;
        remaining -= bytesRead;
        pending += buffer.subarray(0, bytesRead).toString("utf8");
        while (true) {
          const nl = pending.indexOf("\n");
          if (nl === -1) break;
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          const trimmed = line.trim();
          if (trimmed) enqueue(trimmed);
        }
      }
      offset = position;
    } finally {
      reading = false;
      if (readQueued) {
        readQueued = false;
        // Process any additional bytes appended while we were reading
        void readNew();
      }
    }
  };

  // Watch the directory for file create/rename/change
  const watcher = fsSync.watch(dir, { persistent: true }, (event, filename) => {
    if (aborted) return;
    if (!filename || filename !== base) return;
    if (event === "rename") {
      (async () => {
        try {
          try {
            const fh = handle;
            if (fh) await fh.close();
          } catch {}
          handle = null;
          offset = 0;
          pending = "";
          await openIfNeeded(true);
          await readNew();
        } catch {}
      })();
    } else if (event === "change") {
      void readNew();
    }
  });

  try {
    // Try opening immediately if file is already present
    await openIfNeeded(true);
    if (!startAtEnd) await readNew();

    while (!aborted) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        continue;
      }
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
      }
    }
  } finally {
    try {
      watcher.close();
    } catch {}
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
