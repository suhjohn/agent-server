export class AgentError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status = 500, details?: unknown) {
    super(message);
    this.name = "AgentError";
    this.status = status;
    this.details = details;
  }
}

export const isAgentError = (error: unknown): error is AgentError => {
  return error instanceof AgentError;
};
