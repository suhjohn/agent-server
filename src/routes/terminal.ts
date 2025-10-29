import { Router, Request, Response } from "express";
import { z } from "zod";

import { validateApiKey } from "@/middleware/auth";
import { createTerminalJwt } from "@/services/terminalAuthService";
import { isAgentError } from "@/utils/errors";
import { TerminalTokenRequestSchema } from "@/types/terminal";

const router: Router = Router();

const requestSchema = TerminalTokenRequestSchema.extend({
  terminalId: z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    })
    .refine(
      (value) =>
        value === undefined || (value.length >= 1 && value.length <= 128),
      {
        message: "terminalId must be between 1 and 128 characters",
      }
    ),
});

router.post("/token", validateApiKey, (req: Request, res: Response): void => {
  const parsed = requestSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten(),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const { deploymentId, terminalId } = parsed.data;

  try {
    const tokenResult = createTerminalJwt({
      deploymentId,
      ...(terminalId && { terminalId }),
    });

    res.json({
      token: tokenResult.token,
      expiresAt: tokenResult.expiresAt.toISOString(),
      deploymentId,
      terminalId,
    });
  } catch (error) {
    if (isAgentError(error)) {
      res.status(error.status).json({
        error: error.message,
        details: error.details,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    console.error("Failed to generate terminal token", error);
    res.status(500).json({
      error: "Failed to generate terminal token",
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
