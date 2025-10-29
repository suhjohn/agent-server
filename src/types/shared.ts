import { z } from "zod";

export const AgentIdentifierSchema = z.enum(["claude-code", "codex"]);

export const DeploymentSessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  agent: AgentIdentifierSchema,
  cwd: z.string().nullish(),
  model: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isStreaming: z.boolean().optional(),
  internalSessionId: z.string().optional(),
});

export const DeploymentSessionsResponseSchema = z.object({
  sessions: z.array(DeploymentSessionSchema),
  count: z.number(),
  timestamp: z.string(),
});

export const ClaudeSessionMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
  contents: z.array(z.any()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ClaudeSessionMessagesResponseSchema = z.object({
  sessionId: z.string(),
  messages: z.array(ClaudeSessionMessageSchema),
  count: z.number(),
  timestamp: z.string(),
});

export const FilesystemEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["directory", "file"]),
  path: z.string(),
  inGitRepo: z.boolean(),
  gitRoot: z.string().nullable(),
});

export const FilesystemDirectoriesResponseSchema = z.object({
  path: z.string(),
  fullPath: z.string(),
  entries: z.array(FilesystemEntrySchema),
  count: z.number(),
  timestamp: z.string(),
  maxDepth: z.number().optional(),
});

export const CreateSessionRequestSchema = z.object({
  sessionId: z.string().uuid("Valid session ID required"),
  agent: AgentIdentifierSchema.default("claude-code"),
  cwd: z.string(),
  model: z.string().optional(),
});

export const UpdateSessionRequestSchema = z.object({
  name: z.string(),
});

export const GenerateRequestSchema = z.object({
  prompt: z.string().min(1, "Prompt is required"),
  session_id: z.string().uuid("Valid session ID required"),
  message_id: z.string().optional(),
  agent: AgentIdentifierSchema.default("claude-code"),
  cwd: z.string(),
  model: z.string(),
  use_worktree: z.boolean().optional().default(false),
  background: z.boolean().optional().default(false),
  images: z.array(z.string()).optional(),
});

export const StopGenerationRequestSchema = z.object({
  session_id: z.string().uuid("Valid session ID required"),
});

export const StopResponseSchema = z.object({
  stopped: z.boolean(),
  sessionId: z.string(),
  timestamp: z.string(),
});

export const TerminalTokenRequestSchema = z.object({
  deploymentId: z.string().uuid("Valid deployment ID required"),
  terminalId: z.string().optional(),
});

export const TerminalTokenResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  deploymentId: z.string().uuid("Valid deployment ID required"),
  terminalId: z.string().optional(),
});

export type AgentIdentifier = z.infer<typeof AgentIdentifierSchema>;
export type DeploymentSession = z.infer<typeof DeploymentSessionSchema>;
export type DeploymentSessionsResponse = z.infer<
  typeof DeploymentSessionsResponseSchema
>;
export type ClaudeSessionMessage = z.infer<typeof ClaudeSessionMessageSchema>;
export type ClaudeSessionMessagesResponse = z.infer<
  typeof ClaudeSessionMessagesResponseSchema
>;
export type FilesystemEntry = z.infer<typeof FilesystemEntrySchema>;
export type FilesystemDirectoriesResponse = z.infer<
  typeof FilesystemDirectoriesResponseSchema
>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>;
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
export type StopGenerationRequest = z.infer<typeof StopGenerationRequestSchema>;
export type StopResponse = z.infer<typeof StopResponseSchema>;
export type TerminalTokenRequest = z.infer<typeof TerminalTokenRequestSchema>;
export type TerminalTokenResponse = z.infer<typeof TerminalTokenResponseSchema>;
