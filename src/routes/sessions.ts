import { Router, Request, Response } from "express";
import { validateApiKey } from "../middleware/auth";
import { CreateSessionRequest, UpdateSessionSchema } from "../types/session";
import {
  listSessionsWithStreaming,
  createSessionRecord,
  getSessionMessagesResponse,
  updateSessionNameResponse,
  deleteSessionById,
  getFilesystemDirectories,
  uploadFilesToFilesystem,
} from "@/services/sessionService";
import { isAgentError } from "@/utils/errors";
import multer from "multer";

const router: Router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per file
    fields: 1000,
    files: 500,
  },
});

const respondWithAgentError = (
  res: Response,
  error: unknown,
  fallbackMessage: string
) => {
  if (isAgentError(error)) {
    res.status(error.status).json({
      error: error.message,
      details: error.details,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  console.error(fallbackMessage, error);
  res.status(500).json({
    error: fallbackMessage,
    timestamp: new Date().toISOString(),
  });
};

router.get("/", async (_req: Request, res: Response) => {
  try {
    const payload = await listSessionsWithStreaming();
    res.json(payload);
  } catch (error) {
    respondWithAgentError(res, error, "Failed to fetch sessions");
  }
});

router.post(
  "/",
  validateApiKey,
  async (req: Request<{}, {}, CreateSessionRequest>, res: Response) => {
    try {
      const { sessionId, agent, cwd, model } = req.body;
      const session = await createSessionRecord({
        sessionId,
        agent,
        cwd,
        model,
      });
      res.status(201).json(session);
    } catch (error) {
      respondWithAgentError(res, error, "Failed to create session");
    }
  }
);

router.get(
  "/:sessionId/messages",
  validateApiKey,
  async (req: Request<{ sessionId: string }>, res: Response) => {
    try {
      const { sessionId } = req.params;
      const payload = await getSessionMessagesResponse(sessionId);
      res.json(payload);
    } catch (error) {
      respondWithAgentError(res, error, "Failed to fetch session messages");
    }
  }
);

router.put(
  "/:sessionId",
  validateApiKey,
  async (req: Request<{ sessionId: string }>, res: Response) => {
    try {
      const { sessionId } = req.params;

      const parseResult = UpdateSessionSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parseResult.error.errors,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { name } = parseResult.data;

      const payload = await updateSessionNameResponse(sessionId, name);

      res.json(payload);
    } catch (error) {
      respondWithAgentError(res, error, "Failed to update session");
    }
  }
);

router.delete(
  "/:sessionId",
  validateApiKey,
  async (req: Request<{ sessionId: string }>, res: Response) => {
    try {
      const { sessionId } = req.params;
      const payload = await deleteSessionById(sessionId);
      res.json(payload);
    } catch (error) {
      respondWithAgentError(res, error, "Failed to delete session");
    }
  }
);

/**
 * GET /filesystem/directories
 * Get all subdirectories using OS-native find command for better performance
 */
router.get(
  "/filesystem/directories",
  validateApiKey,
  async (req: Request, res: Response) => {
    try {
      const { path: targetPathQuery, includeFiles, maxDepth } = req.query;
      const targetPath =
        typeof targetPathQuery === "string" ? targetPathQuery : undefined;
      const includeFilesFlag =
        typeof includeFiles === "string" && includeFiles === "true";
      const depthValue =
        typeof maxDepth === "string" ? Number.parseInt(maxDepth, 10) : undefined;

      const options: Parameters<typeof getFilesystemDirectories>[0] = {
        path: targetPath ?? "",
        includeFiles: includeFilesFlag,
      };

      if (
        typeof depthValue === "number" &&
        Number.isFinite(depthValue) &&
        depthValue >= 1
      ) {
        options.maxDepth = depthValue;
      }

      const payload = await getFilesystemDirectories(options);

      res.json(payload);
    } catch (error) {
      respondWithAgentError(res, error, "Failed to read directory");
    }
  }
);

router.post(
  "/filesystem/upload",
  validateApiKey,
  upload.any(),
  async (req: Request, res: Response) => {
    try {
      const targetPath =
        typeof req.body?.targetPath === "string" ? req.body.targetPath : "";
      const rawRelativePaths = req.body?.relativePaths;
      const relativePaths = Array.isArray(rawRelativePaths)
        ? rawRelativePaths
        : typeof rawRelativePaths === "string"
          ? [rawRelativePaths]
          : [];

      const rawFiles = Array.isArray(req.files)
        ? req.files
        : req.files
          ? Object.values(req.files).flat()
          : [];

      const payload = await uploadFilesToFilesystem({
        path: targetPath,
        files: rawFiles.map((file, index) => ({
          originalname:
            relativePaths[index] ||
            file.originalname ||
            file.fieldname,
          buffer: file.buffer,
          size: file.size,
        })),
      });

      res.status(201).json(payload);
    } catch (error) {
      respondWithAgentError(res, error, "Failed to upload files");
    }
  }
);

export default router;
