import { z } from "zod";

// Deployment health check schema
export const deploymentHealthCheckSchema = z.object({
  deploymentId: z.string().uuid("Valid deployment ID required"),
  healthUrl: z.string().url("Valid health check URL required").optional(),
});

export type DeploymentHealthCheck = z.infer<typeof deploymentHealthCheckSchema>;

// Deployment status schema
export const deploymentStatusSchema = z.object({
  deploymentId: z.string().uuid(),
  status: z.enum(["healthy", "unhealthy", "unknown", "checking"]),
  lastChecked: z.date(),
  healthEndpoint: z.string().url().optional(),
  responseTime: z.number().optional(),
  error: z.string().optional(),
});

export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

// Health check response from deployment instance
export const instanceHealthResponseSchema = z.object({
  status: z.enum(["healthy", "unhealthy"]),
  timestamp: z.string(),
  version: z.string().optional(),
  uptime: z.number().optional(),
});

export type InstanceHealthResponse = z.infer<typeof instanceHealthResponseSchema>;

// Chat enablement check
export const chatEnablementSchema = z.object({
  deploymentId: z.string().uuid(),
  enabled: z.boolean(),
  reason: z.string().optional(),
  timestamp: z.date(),
});

export type ChatEnablement = z.infer<typeof chatEnablementSchema>;