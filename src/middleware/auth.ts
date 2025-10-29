import type { IncomingHttpHeaders } from "http";
import { Request, Response, NextFunction } from "express";

import { apiKeyHeaderSchema } from "../types/generate";
import { AgentError, isAgentError } from "@/utils/errors";

export interface AuthenticatedRequest extends Request {
  apiKey: string;
}

const extractApiKey = (headers: IncomingHttpHeaders) => {
  const authorization = headers.authorization;
  return authorization?.startsWith("Bearer ")
    ? authorization.replace("Bearer ", "")
    : authorization ?? "";
};

export const getValidatedApiKey = (headers: IncomingHttpHeaders): string => {
  const expectedApiKey = process.env.API_KEY;

  if (!expectedApiKey) {
    throw new AgentError("API key not configured on server", 500);
  }

  const headerValidation = apiKeyHeaderSchema.safeParse(headers);

  if (!headerValidation.success) {
    throw new AgentError(
      "Invalid authorization header format. Expected: Bearer <token>",
      401,
      headerValidation.error.errors
    );
  }

  const token = extractApiKey(headers);

  if (!token || token !== expectedApiKey) {
    throw new AgentError("Invalid API key", 401);
  }

  return token;
};

/**
 * Middleware to validate API key from Authorization header
 */
export const validateApiKey = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  try {
    const token = getValidatedApiKey(req.headers);
    (req as AuthenticatedRequest).apiKey = token;
    next();
  } catch (error) {
    if (isAgentError(error)) {
      res.status(error.status).json({
        error: error.message,
        details: error.details,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    console.error("Authentication error:", error);
    res.status(500).json({
      error: "Authentication failed",
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * Type guard to check if request is authenticated
 */
export const isAuthenticatedRequest = (
  req: Request
): req is AuthenticatedRequest => {
  return "apiKey" in req;
};
