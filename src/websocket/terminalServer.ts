import type { Server as HttpServer } from "http";
import { URL } from "url";
import { WebSocketServer, WebSocket, RawData } from "ws";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { IncomingMessage } from "http";

import {
  getWorkspaceBasePath,
  verifyTerminalJwt,
} from "@/services/terminalAuthService";
import { AgentError } from "@/utils/errors";

const DEFAULT_SHELL =
  process.env.TERMINAL_SHELL ?? process.env.SHELL ?? "/bin/bash";

const MAX_BUFFERED_MESSAGES = 1000;

const readMessage = (raw: RawData): string | null => {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Buffer) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return null;
};

const sendJson = (socket: WebSocket, payload: unknown) => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
};

const extractToken = (
  request: IncomingMessage,
  requestUrl: string | undefined
) => {
  if (request.headers.authorization?.startsWith("Bearer ")) {
    return request.headers.authorization.slice("Bearer ".length).trim();
  }

  if (!requestUrl) {
    return null;
  }

  const url = new URL(
    requestUrl,
    `http://${request.headers.host ?? "localhost"}`
  );

  return url.searchParams.get("token");
};

interface TerminalServerOptions {
  path?: string;
}

export const attachTerminalServer = (
  server: HttpServer,
  options: TerminalServerOptions = {}
) => {
  const wss = new WebSocketServer({
    server,
    path: options.path ?? "/ws/terminal",
  });

  wss.on("connection", (socket, request) => {
    let terminal: IPty | null = null;
    let closed = false;
    const bufferedOutputs: string[] = [];

    const cleanupTerminal = () => {
      try {
        if (terminal) {
          terminal.kill();
          terminal = null;
        }
      } catch (error) {
        console.error("Failed to terminate PTY", error);
      }
    };

    const closeSocket = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      cleanupTerminal();

      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(code, reason);
        } else {
          socket.terminate();
        }
      } catch (error) {
        console.error("Failed to close terminal WebSocket", error);
      }
    };

    const flushBufferedOutputs = () => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      while (bufferedOutputs.length) {
        const chunk = bufferedOutputs.shift();
        if (!chunk) {
          break;
        }
        sendJson(socket, { type: "data", data: chunk });
      }
    };

    try {
      const token = extractToken(request, request.url);
      if (!token) {
        throw new AgentError("Missing terminal token", 401);
      }

      const payload = verifyTerminalJwt(token);
      const workingDir = getWorkspaceBasePath();

      if (!DEFAULT_SHELL) {
        throw new AgentError("Shell executable not configured", 500);
      }

      terminal = pty.spawn(DEFAULT_SHELL, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: workingDir,
        env: {
          ...process.env,
          DEPLOYMENT_ID: payload.deploymentId,
          TERMINAL_ID: payload.terminalId ?? "",
        },
      });

      terminal.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) {
          sendJson(socket, { type: "data", data });
        } else {
          if (bufferedOutputs.length >= MAX_BUFFERED_MESSAGES) {
            bufferedOutputs.shift();
          }
          bufferedOutputs.push(data);
        }
      });

      terminal.onExit(({ exitCode, signal }) => {
        sendJson(socket, {
          type: "close",
          data: `Terminal exited (code=${exitCode}${
            signal ? `, signal=${signal}` : ""
          })`,
        });
        closeSocket(1000, "Terminal session ended");
      });

      socket.on("message", (raw) => {
        const message = readMessage(raw);
        if (!message) {
          return;
        }

        try {
          const payload = JSON.parse(message) as {
            type?: string;
            data?: string;
            cols?: number;
            rows?: number;
          };

          if (payload.type === "data" && typeof payload.data === "string") {
            terminal?.write(payload.data);
            return;
          }

          if (
            payload.type === "resize" &&
            typeof payload.cols === "number" &&
            typeof payload.rows === "number" &&
            payload.cols > 0 &&
            payload.rows > 0
          ) {
            terminal?.resize(payload.cols, payload.rows);
            return;
          }
        } catch (error) {
          console.warn("Failed to process terminal message", error);
        }
      });

      socket.on("close", () => {
        closed = true;
        cleanupTerminal();
      });

      socket.on("error", (error) => {
        console.error("Terminal WebSocket error", error);
        closeSocket(1011, "WebSocket error");
      });

      sendJson(socket, {
        type: "info",
        data: `Connected to ${DEFAULT_SHELL} in ${workingDir}`,
      });
      flushBufferedOutputs();
    } catch (error) {
      if (error instanceof AgentError) {
        sendJson(socket, { type: "error", data: error.message });
        closeSocket(
          error.status >= 400 && error.status < 500 ? 1008 : 1011,
          error.message
        );
        return;
      }

      console.error("Unhandled terminal connection error", error);
      sendJson(socket, {
        type: "error",
        data: "Failed to open terminal session",
      });
      closeSocket(1011, "Terminal initialization failed");
    }
  });

  return wss;
};
