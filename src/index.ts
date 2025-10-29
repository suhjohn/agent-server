import "dotenv/config";
import { createServer } from "http";

import createApp from "./app";
import { attachTerminalServer } from "./websocket/terminalServer";

const PORT = Number(process.env.PORT) || 3000;
// Default to 0.0.0.0 to satisfy Fly.io health checks
const HOST = process.env.HOST || "0.0.0.0";
const displayHost = HOST === "::" ? "[::]" : HOST;
const startServer = async (): Promise<void> => {
  try {
    const app = createApp();
    const server = createServer(app);
    const terminalServer = attachTerminalServer(server);

    server.listen(Number(PORT), HOST, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(
        `📊 Health check available at http://${displayHost}:${PORT}/health`
      );
      console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`);
      console.log(
        `🖥️  Terminal WebSocket available at ws://${displayHost}:${PORT}/ws/terminal`
      );
    });

    const shutdown = async (signal: string): Promise<void> => {
      console.log(`\n📡 Received ${signal}. Starting graceful shutdown...`);
      terminalServer.clients.forEach((client) => {
        try {
          client.terminate();
        } catch (error) {
          console.error("Failed to terminate terminal client", error);
        }
      });

      terminalServer.close(() => {
        console.log("🔌 Terminal WebSocket server closed");
        server.close(() => {
          console.log("🔌 HTTP server closed");
          console.log("✅ Graceful shutdown completed");
          process.exit(0);
        });
      });

      setTimeout(() => {
        console.error("⚠️  Forceful shutdown after timeout");
        process.exit(1);
      }, 30000);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

// Start the server
startServer();
