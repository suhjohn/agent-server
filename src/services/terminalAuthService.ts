import jwt, { JwtPayload } from "jsonwebtoken";
import path from "path";
import { randomUUID } from "crypto";
import fs from "fs";
import { AgentError } from "@/utils/errors";

const BASE_WORKSPACE_PATH = process.env.WORKSPACE_BASE_PATH ?? "/home/appuser";
const JWT_SECRET = process.env.API_KEY;
const JWT_TTL = 60 * 60 * 24 * 7; // seconds (7 days)

export interface TerminalJwtPayload extends JwtPayload {
  deploymentId: string;
  terminalId?: string;
  scope: "terminal";
}

interface CreateTerminalJwtOptions {
  deploymentId: string;
  terminalId?: string;
}

export interface TerminalJwtResult {
  token: string;
  expiresAt: Date;
}

// Validate path is within workspace
const validatePath = (targetPath: string): string => {
  const resolved = path.resolve(BASE_WORKSPACE_PATH, targetPath);
  if (!resolved.startsWith(BASE_WORKSPACE_PATH)) {
    throw new AgentError("Path must be within workspace", 400);
  }
  return resolved;
};

export const createTerminalJwt = ({
  deploymentId,
  terminalId,
}: CreateTerminalJwtOptions): TerminalJwtResult => {
  if (!JWT_SECRET) throw new AgentError("JWT secret not configured", 500);
  if (!deploymentId) throw new AgentError("deploymentId required", 400);

  const payload: TerminalJwtPayload = {
    deploymentId,
    scope: "terminal",
    ...(terminalId && { terminalId }),
  };

  const token = jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_TTL,
    jwtid: randomUUID(),
  });

  return {
    token,
    expiresAt: new Date(Date.now() + JWT_TTL * 1000),
  };
};

export const verifyTerminalJwt = (token: string): TerminalJwtPayload => {
  if (!JWT_SECRET) throw new AgentError("JWT secret not configured", 500);
  if (!token) throw new AgentError("Token required", 401);

  try {
    const payload = jwt.verify(token, JWT_SECRET) as TerminalJwtPayload;

    if (payload.scope !== "terminal" || !payload.deploymentId) {
      throw new AgentError("Invalid token", 401);
    }

    return payload;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError("Invalid or expired token", 401);
  }
};

export const getWorkspaceBasePath = () => BASE_WORKSPACE_PATH;

export const ensureWorkingDirectoryExists = (cwd?: string): string => {
  const targetPath = cwd || BASE_WORKSPACE_PATH;
  const resolved = validatePath(targetPath);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new AgentError("Directory does not exist", 400);
  }

  return resolved;
};
