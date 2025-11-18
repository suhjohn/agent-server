import { Router, Request, Response } from "express";
import { validateApiKey } from "../middleware/auth";
import {
  generateRequestSchema,
  stopGenerationRequestSchema,
  type GenerateRequest,
} from "../types/generate";
import { createUserMessage, getOrCreateSession } from "@/db/session";
import { redisClient } from "@/redis";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { queryCodex } from "@/services/codex";
import { findCodexSessionFileById, tailJsonlFile } from "@/services/codex";
import { updateInternalSessionId, updateSession } from "@/db/session";
import { createMessage } from "@/db/session";
import { getMessages, updateSessionCwd } from "@/db/session";
import { createWorktree, getGitRoot } from "@/services/git";
import { readFile } from "fs/promises";
import { extname } from "path";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";

const router: Router = Router();
const sessionAbortControllers = new Map<string, AbortController>();
const MCP_SERVERS: Record<string, any> = {};

type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
type BackgroundJob = {
  taskId: string;
  sessionId: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  events: string[];
  emitter: EventEmitter;
  abortController: AbortController;
  activeSessionKey: string;
};

const backgroundJobs = new Map<string, BackgroundJob>();

async function runGenerationCore(params: {
  agent: "claude-code" | "codex";
  generateRequest: GenerateRequest;
  session: any;
  sessionId: string;
  workingCwd: string;
  abortController: AbortController;
  onEvent: (data: string) => void;
}): Promise<void> {
  const {
    agent,
    generateRequest,
    session,
    sessionId,
    workingCwd,
    abortController,
    onEvent,
  } = params;

  if (agent === "claude-code") {
    // Prepare prompt - either simple text or multimodal with images
    let promptInput: string | AsyncIterable<SDKUserMessage>;

    if (generateRequest.images && generateRequest.images.length > 0) {
      // Read images and create multimodal prompt
      const imageData = await readImagesAsBase64(generateRequest.images);
      promptInput = createMultimodalPrompt(
        sessionId,
        generateRequest.prompt,
        imageData
      );
    } else {
      // Simple text prompt
      promptInput = generateRequest.prompt;
    }

    const messages = query({
      prompt: promptInput,
      options: {
        resume: session.internalSessionId,
        mcpServers: MCP_SERVERS,
        permissionMode: "bypassPermissions",
        cwd: workingCwd,
        model: session.model,
        systemPrompt: { type: "preset", preset: "claude_code" },
      },
    });
    for await (const message of messages) {
      if (abortController.signal.aborted) break;
      if (message.type === "system" && message.subtype === "init") {
        await updateInternalSessionId(sessionId, message.session_id);
      }
      if (message.uuid) {
        await createMessage(sessionId, message.uuid, message);
      }
      onEvent(JSON.stringify(message));
    }
    await updateSession(sessionId);
    onEvent('{"done": true}');
    return;
  } else if (agent === "codex") {
    const messages = queryCodex({
      prompt: generateRequest.prompt,
      abortController,
      options: {
        resume: session.internalSessionId,
        cwd: workingCwd,
        model: session.model,
        approvalPolicy: "never",
        mcpServers: MCP_SERVERS,
        images: generateRequest.images,
        modelReasoningEffort: "high",
      },
    });

    let tailStarted = false;
    let currentFilePath: string | null =
      (await findCodexSessionFileById(session.internalSessionId)) ?? null;

    const startTail = (filePath: string) => {
      if (tailStarted) return;
      tailStarted = true;
      currentFilePath = filePath;
      (async () => {
        try {
          for await (const line of tailJsonlFile(filePath, {
            signal: abortController.signal,
            startAtEnd: true,
          })) {
            if (abortController.signal.aborted) break;
            onEvent(line);
          }
        } catch {
          // swallow
        }
      })();
    };

    if (currentFilePath) {
      startTail(currentFilePath);
    }

    for await (const message of messages) {
      if (abortController.signal.aborted) break;
      if (message.type === "init") {
        await updateInternalSessionId(sessionId, message.session_id);
        startTail(message.session_file_path);
      }
      if (message.type === "done") {
        break;
      }
    }

    try {
      abortController.abort();
    } catch {}

    await updateSession(sessionId);
    onEvent('{"done": true}');
    return;
  } else {
    onEvent(JSON.stringify({ type: "error", error: "Invalid type" }));
    return;
  }
}

/**
 * Determines the media type from a file extension
 */
function getMediaTypeFromExtension(
  filepath: string
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const ext = extname(filepath).toLowerCase();
  const mediaTypeMap: Record<
    string,
    "image/jpeg" | "image/png" | "image/gif" | "image/webp"
  > = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return mediaTypeMap[ext] || "image/jpeg";
}

/**
 * Reads image files and converts them to base64
 */
async function readImagesAsBase64(imagePaths: string[]): Promise<
  Array<{
    data: string;
    mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  }>
> {
  const images = await Promise.all(
    imagePaths.map(async (path) => {
      const buffer = await readFile(path);
      const base64Data = buffer.toString("base64");
      const mediaType = getMediaTypeFromExtension(path);
      return { data: base64Data, mediaType };
    })
  );
  return images;
}

/**
 * Creates an async generator for multimodal prompts (text + images)
 */
async function* createMultimodalPrompt(
  sessionId: string,
  textPrompt: string,
  images: Array<{
    data: string;
    mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  }>
): AsyncGenerator<SDKUserMessage> {
  const contentBlocks: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: {
          type: "base64";
          media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
          data: string;
        };
      }
  > = [
    {
      type: "text",
      text: textPrompt,
    },
    ...images.map((img) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: img.mediaType,
        data: img.data,
      },
    })),
  ];

  const messageParam: MessageParam = {
    role: "user",
    content: contentBlocks,
  };

  yield {
    type: "user",
    message: messageParam,
    session_id: sessionId,
    parent_tool_use_id: null,
  };
}

router.post("/v2", validateApiKey, async (req: Request, res: Response) => {
  // Validate request body
  const validation = generateRequestSchema.safeParse(req.body);

  if (!validation.success) {
    res.status(400).json({
      error: "Validation failed",
      details: validation.error.errors,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const generateRequest: GenerateRequest = validation.data;
  const sessionId = generateRequest.session_id;
  const agent = generateRequest.agent;
  const wantWorktree = Boolean(generateRequest.use_worktree);

  const session = await getOrCreateSession(
    sessionId,
    generateRequest.agent,
    generateRequest.cwd,
    generateRequest.model
  );

  // Determine if this is the first turn (before we insert the synthetic user message)
  const existingMessages = await getMessages(sessionId);
  const isFirstTurn = existingMessages.length === 0;

  const isBackground = Boolean((generateRequest as any).background);
  if (!isBackground) {
    // SSE headers
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Cache-Control");
  }

  const send = (data: string) => {
    res.write(`data: ${data.replace(/\n/g, "\\n")}\n\n`);
  };

  let closed = false;
  const close = (code = 200) => {
    if (closed) return;
    closed = true;
    try {
      res.statusCode = code;
      res.end();
    } catch {}
  };

  // Keep connection alive (foreground only)
  const keepAlive = !isBackground
    ? setInterval(() => {
        if (!closed) {
          res.write(": keepalive\n\n");
        }
      }, 30000)
    : null;

  const abortController = new AbortController();
  sessionAbortControllers.set(sessionId, abortController);
  const activeSessionKey = `session:active:${sessionId}`;
  const lockAcquired = await redisClient.set(
    activeSessionKey,
    "1",
    "EX",
    3600, // 1 hour expiration
    "NX" // Only set if not exists
  );
  if (!lockAcquired) {
    throw new Error(`Session ${sessionId} is already processing a request`);
  }
  // Ensure cleanup on client disconnect (foreground only)
  if (!isBackground) {
    req.on("close", () => {
      try {
        abortController.abort();
      } finally {
        if (keepAlive) clearInterval(keepAlive);
        sessionAbortControllers.delete(sessionId);
        close();
      }
    });
  }
  const internalSessionId = session.internalSessionId;
  // Resolve working directory, possibly switching to a new git worktree
  let workingCwd = session.cwd;
  try {
    if (wantWorktree && isFirstTurn) {
      const gitRoot = await getGitRoot(session.cwd);
      if (gitRoot) {
        const { worktreePath } = await createWorktree({
          gitRoot,
          sessionId,
        });
        await updateSessionCwd(sessionId, worktreePath);
        workingCwd = worktreePath;
        // Inform client early that cwd switched to a worktree
        send(
          JSON.stringify({
            type: "system",
            subtype: "worktree_init",
            cwd: worktreePath,
            git_root: gitRoot,
          })
        );
      }
    }
  } catch (err) {
    // Non-fatal; continue with original cwd
    console.warn("Failed to create worktree:", err);
  }
  const userMessage = await createUserMessage(
    sessionId,
    generateRequest.prompt
  );

  if (isBackground) {
    const taskId = randomUUID();
    const activeSessionKey = `session:active:${sessionId}`;
    // Already acquired above; keep reference for cleanup in job

    const job: BackgroundJob = {
      taskId,
      sessionId,
      status: "queued",
      createdAt: new Date().toISOString(),
      events: [],
      emitter: new EventEmitter(),
      abortController,
      activeSessionKey,
    };

    backgroundJobs.set(taskId, job);

    // Emit the user message contents first
    for (const content of userMessage.contents ?? []) {
      const line = JSON.stringify(content);
      job.events.push(line);
      job.emitter.emit("event", line);
    }

    // Resolve working directory (same logic as foreground, but without SSE notify on worktree)
    let workingCwd = session.cwd;
    try {
      if (wantWorktree && isFirstTurn) {
        const gitRoot = await getGitRoot(session.cwd);
        if (gitRoot) {
          const { worktreePath } = await createWorktree({ gitRoot, sessionId });
          await updateSessionCwd(sessionId, worktreePath);
          workingCwd = worktreePath;
          job.events.push(
            JSON.stringify({
              type: "system",
              subtype: "worktree_init",
              cwd: worktreePath,
              git_root: gitRoot,
            })
          );
          job.emitter.emit(
            "event",
            JSON.stringify({
              type: "system",
              subtype: "worktree_init",
              cwd: worktreePath,
              git_root: gitRoot,
            })
          );
        }
      }
    } catch (err) {
      console.warn("Failed to create worktree:", err);
    }

    // Start background processing
    setImmediate(async () => {
      job.status = "running";
      job.startedAt = new Date().toISOString();
      const onEvent = (line: string) => {
        job.events.push(line);
        job.emitter.emit("event", line);
      };
      try {
        await runGenerationCore({
          agent: agent as any,
          generateRequest,
          session,
          sessionId,
          workingCwd,
          abortController,
          onEvent,
        });
        job.status = "completed";
      } catch (e: any) {
        console.error("background run error:", e);
        onEvent(
          JSON.stringify({
            type: "error",
            error: e instanceof Error ? e.message : String(e),
          })
        );
        job.status = "failed";
        job.error = e instanceof Error ? e.message : String(e);
      } finally {
        job.finishedAt = new Date().toISOString();
        job.emitter.emit("done");
        sessionAbortControllers.delete(sessionId);
        await redisClient.del(activeSessionKey);
      }
    });

    res.status(202).json({ taskId, sessionId, status: "queued" });
    return;
  }

  try {
    if (agent === "claude-code") {
      // Send the user message
      for (const content of userMessage.contents ?? []) {
        send(JSON.stringify(content));
      }

      // Prepare prompt - either simple text or multimodal with images
      let promptInput: string | AsyncIterable<SDKUserMessage>;

      if (generateRequest.images && generateRequest.images.length > 0) {
        // Read images and create multimodal prompt
        try {
          const imageData = await readImagesAsBase64(generateRequest.images);
          promptInput = createMultimodalPrompt(
            sessionId,
            generateRequest.prompt,
            imageData
          );
        } catch (err) {
          console.error("Failed to read images:", err);
          send(
            JSON.stringify({
              type: "error",
              error: `Failed to read images: ${
                err instanceof Error ? err.message : String(err)
              }`,
            })
          );
          if (keepAlive) clearInterval(keepAlive);
          close(400);
          return;
        }
      } else {
        // Simple text prompt
        promptInput = generateRequest.prompt;
      }

      const messages = query({
        prompt: promptInput,
        options: {
          resume: internalSessionId,
          mcpServers: MCP_SERVERS,
          permissionMode: "bypassPermissions",
          cwd: workingCwd,
          model: session.model,
          systemPrompt: { type: "preset", preset: "claude_code" },
        },
      });
      for await (const message of messages) {
        if (abortController.signal.aborted) break;
        if (message.type === "system" && message.subtype === "init") {
          await updateInternalSessionId(sessionId, message.session_id);
        }
        if (message.uuid) {
          await createMessage(sessionId, message.uuid, message);
        }
        send(JSON.stringify(message));
      }
      await updateSession(sessionId);
      send('{"done": true}');
      if (keepAlive) clearInterval(keepAlive);
      close();
    } else if (agent === "codex") {
      const messages = queryCodex({
        prompt: generateRequest.prompt,
        abortController,
        options: {
          resume: session.internalSessionId,
          cwd: workingCwd,
          model: session.model,
          approvalPolicy: "never",
          mcpServers: MCP_SERVERS,
          images: generateRequest.images,
          modelReasoningEffort: "high",
        },
      });

      let tailStarted = false;
      let tailTask: Promise<void> | null = null;
      let currentFilePath: string | null =
        (await findCodexSessionFileById(session.internalSessionId)) ?? null;

      const startTail = (filePath: string) => {
        if (tailStarted) return;
        tailStarted = true;
        currentFilePath = filePath;
        tailTask = (async () => {
          try {
            for await (const line of tailJsonlFile(filePath, {
              signal: abortController.signal,
              startAtEnd: true,
            })) {
              if (abortController.signal.aborted) break;
              send(line);
            }
          } catch (err) {
            // swallow; SSE should continue to finalize
          }
        })();
      };

      // If resuming, start tailing immediately from end
      if (currentFilePath) {
        startTail(currentFilePath);
      }

      for await (const message of messages) {
        if (abortController.signal.aborted) break;
        if (message.type === "init") {
          await updateInternalSessionId(sessionId, message.session_id);
          startTail(message.session_file_path);
        }
        if (message.type === "done") {
          break;
        }
      }

      // Signal tailer to stop and finalize response
      try {
        abortController.abort();
      } catch {}

      await updateSession(sessionId);
      send('{"done": true}');
      if (keepAlive) clearInterval(keepAlive);
      close();
    } else {
      send(JSON.stringify({ type: "error", error: "Invalid type" }));
      if (keepAlive) clearInterval(keepAlive);
      close(400);
    }
  } catch (e) {
    console.error("/v2 stream error:", e);
    try {
      send('{"type":"error","content":"Stream failed","done":true}');
    } finally {
      if (keepAlive) clearInterval(keepAlive);
      close(500);
    }
  } finally {
    sessionAbortControllers.delete(sessionId);
    await redisClient.del(activeSessionKey);
  }
});

// Background job status
router.get(
  "/v2/jobs/:taskId",
  validateApiKey,
  async (req: Request, res: Response) => {
    const { taskId } = req.params as { taskId: string };
    const job = backgroundJobs.get(taskId);
    if (!job) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({
      taskId: job.taskId,
      sessionId: job.sessionId,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
    });
  }
);

// Background job SSE stream
router.get(
  "/v2/jobs/:taskId/stream",
  validateApiKey,
  async (req: Request, res: Response) => {
    const { taskId } = req.params as { taskId: string };
    const job = backgroundJobs.get(taskId);
    if (!job) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Cache-Control");

    const send = (data: string) => {
      res.write(`data: ${data.replace(/\n/g, "\\n")}\n\n`);
    };

    // Replay existing events
    for (const line of job.events) {
      send(line);
    }

    const onEvent = (line: string) => send(line);
    const onDone = () => {
      try {
        res.end();
      } catch {}
      job.emitter.removeListener("event", onEvent);
      job.emitter.removeListener("done", onDone);
    };

    job.emitter.on("event", onEvent);
    job.emitter.once("done", onDone);

    // Client disconnect
    req.on("close", () => {
      job.emitter.removeListener("event", onEvent);
      job.emitter.removeListener("done", onDone);
      try {
        res.end();
      } catch {}
    });
  }
);

// DELETE /generate/:sessionId/stop - Stop a generation session
router.delete(
  "/:sessionId/stop",
  validateApiKey,
  async (req: Request, res: Response) => {
    const validation = stopGenerationRequestSchema.safeParse(req.body);

    if (!validation.success) {
      res.status(400).json({
        error: "Validation failed",
        details: validation.error.errors,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    const { session_id } = validation.data;

    try {
      const abortController = sessionAbortControllers.get(session_id);
      if (abortController) {
        abortController.abort();
        sessionAbortControllers.delete(session_id);

        res.json({
          stopped: true,
          sessionId: session_id,
          timestamp: new Date().toISOString(),
        });
      } else {
        res.status(404).json({
          error: "Session not found or not active",
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error("Error stopping generation:", error);
      res.status(500).json({
        error: "Failed to stop generation",
        timestamp: new Date().toISOString(),
      });
    }
  }
);

export default router;
