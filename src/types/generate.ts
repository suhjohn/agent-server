import { z } from "zod";

export {
  GenerateRequestSchema as generateRequestSchema,
  StopGenerationRequestSchema as stopGenerationRequestSchema,
} from "./shared";

export type { GenerateRequest, StopGenerationRequest } from "./shared";

// Claude Code session tracking types
export interface ClaudeSessionData {
  sessionId: string;
  messageId?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Claude response types (based on claude-code-js)
export interface ClaudeCodeResponse {
  success: boolean;
  message?: {
    result: string;
    session_id: string;
    cost_usd?: number;
    duration_ms?: number;
  };
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

// Streaming response types
export interface StreamingMessage {
  type: "message" | "system" | "completion";
  content?: string;
  session_id?: string;
  metadata?: {
    cost_usd?: number;
    duration_ms?: number;
    tokens?: number;
    error?: string;
  };
  done?: boolean;
}

// API Key validation
export const apiKeyHeaderSchema = z.object({
  authorization: z
    .string()
    .regex(/^Bearer .+/, "Authorization header must be Bearer token"),
});

// Environment variables
export const envSchema = z.object({
  API_KEY: z.string().min(1, "API_KEY environment variable is required"),
  DATABASE_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.string().default("3000"),
  ALLOWED_ORIGINS: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;
