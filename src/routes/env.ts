import { Router, Request, Response } from "express";
import { z } from "zod";
import { validateApiKey } from "../middleware/auth";

const router: Router = Router();

// Accept a single ENV name or a comma-separated list of names.
// Each token must match /^[A-Z0-9_]+$/ after trimming.
const paramsSchema = z.object({
  env_name: z.string().min(1).max(1024),
});

router.get("/:env_name", validateApiKey, (req: Request, res: Response) => {
  const parsed = paramsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid env_name",
      details: parsed.error.flatten(),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Support comma-separated list: "/env/OPENAI_API_KEY,ANTHROPIC_API_KEY"
  const raw = parsed.data.env_name;
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    res.status(400).json({
      error: "env_name must contain at least one variable name",
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Validate each token format
  const invalid = tokens.find((t) => !/^[A-Z0-9_]+$/.test(t));
  if (invalid) {
    res.status(400).json({
      error:
        "Each env_name must be uppercase alphanumerics and underscores (A-Z, 0-9, _)",
      invalid,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Build a per-key result map
  const results: Record<string, boolean> = {};
  for (const name of tokens) {
    const exists = Object.prototype.hasOwnProperty.call(process.env, name) &&
      typeof process.env[name] === "string" &&
      (process.env[name] as string) !== "";
    results[name] = exists;
  }

  res.json(results);
});

export default router;
