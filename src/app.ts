import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import healthRouter from "./routes/health";
import generateRouter from "./routes/generate";
import sessionsRouter from "./routes/sessions";
import envRouter from "./routes/env";
import terminalRouter from "./routes/terminal";
import gitRouter from "./routes/git";

// Load environment variables
dotenv.config();

const createApp = (): express.Application => {
  const app = express();

  // Security middleware
  app.use(helmet());

  // CORS configuration
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [
    "http://localhost:3000",
  ];
  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
    })
  );

  // Logging middleware
  const logFormat = process.env.NODE_ENV === "production" ? "combined" : "dev";
  app.use(morgan(logFormat));

  // Body parsing middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Routes
  app.use("/health", healthRouter);
  app.use("/generate", generateRouter);
  app.use("/sessions", sessionsRouter);
  app.use("/env", envRouter);
  app.use("/terminal", terminalRouter);
  app.use("/git", gitRouter);

  // Default route
  app.get("/", (_req, res) => {
    res.json({
      message: "Agent TypeScript Server",
      version: process.env.APP_VERSION || "1.0.0",
      timestamp: new Date().toISOString(),
    });
  });

  // 404 handler
  app.use("*", (_req, res) => {
    res.status(404).json({
      error: "Route not found",
      timestamp: new Date().toISOString(),
    });
  });

  // Error handling middleware
  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      console.error("Unhandled error:", error);
      res.status(500).json({
        error: "Internal server error",
        timestamp: new Date().toISOString(),
      });
    }
  );

  return app;
};

export default createApp;
