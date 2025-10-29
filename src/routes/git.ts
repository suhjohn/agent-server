import { Router, type Request, type Response } from "express";
import { validateApiKey } from "../middleware/auth";
import { listGitRepositories, getStructuredDiff } from "@/services/gitService";
import { isAgentError } from "@/utils/errors";

const router: Router = Router();

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

// GET /git/repositories – list git directories under the workspace, including worktrees
router.get(
  "/repositories",
  validateApiKey,
  async (_req: Request, res: Response) => {
    try {
      const payload = await listGitRepositories();
      res.json(payload);
    } catch (error) {
      respondWithAgentError(res, error, "Failed to list git repositories");
    }
  }
);

// GET /git/diff – structured diff for a repo
// Query: path(required)=repoRoot, base(optional), head(optional), staged(optional), context(optional)
router.get(
  "/diff",
  validateApiKey,
  async (req: Request, res: Response) => {
    try {
      const { path, base, head, staged, context } = req.query;
      if (typeof path !== "string" || !path) {
        res.status(400).json({
          error: "Query parameter 'path' is required",
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const opts: Parameters<typeof getStructuredDiff>[0] = {
        repoPath: path,
      };
      if (typeof base === "string" && base.length) {
        opts.base = base;
      }
      if (typeof head === "string" && head.length) {
        opts.head = head;
      }
      if (typeof staged === "string") {
        opts.staged = staged === "true";
      }
      if (typeof context === "string" && Number.isFinite(Number(context))) {
        opts.context = Math.max(0, Math.min(1000, Math.floor(Number(context))));
      }

      const payload = await getStructuredDiff(opts);
      res.json(payload);
    } catch (error) {
      respondWithAgentError(res, error, "Failed to compute git diff");
    }
  }
);

export default router;
