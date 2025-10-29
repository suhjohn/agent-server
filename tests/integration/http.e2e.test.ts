import axios from "axios";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startAgentContainer } from "./helpers/startAgent";
import { randomUUID } from "crypto";
import { StoppedTestContainer } from "testcontainers";

describe("HTTP e2e", () => {
  let baseUrl: string;
  let stop: (() => Promise<StoppedTestContainer>) | undefined;
  let env: Record<string, string>;
  let auth: { headers: Record<string, string> };

  beforeAll(async () => {
    const started = await startAgentContainer();
    baseUrl = started.baseUrl;
    stop = started.stop;
    env = started.env;
    auth = { headers: { Authorization: `Bearer ${env.API_KEY}` } };
  });

  afterAll(async () => {
    if (stop) await stop();
  });

  it("GET /health", async () => {
    const res = await axios.get(`${baseUrl}/health`, { timeout: 20_000 });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("healthy");
  });

  it("GET /env/API_KEY (auth)", async () => {
    const res = await axios.get(`${baseUrl}/env/API_KEY`, {
      ...auth,
      timeout: 20_000,
    });
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("API_KEY", true);
  });

  it("Sessions CRUD (auth)", async () => {
    const sessionId = randomUUID();
    const create = await axios.post(
      `${baseUrl}/sessions`,
      {
        sessionId,
        agent: "claude-code",
        cwd: "/home/appuser",
        model: "test-model",
      },
      { ...auth, timeout: 30_000 }
    );
    expect(create.status).toBe(201);
    expect(create.data.id).toBe(sessionId);

    const list = await axios.get(`${baseUrl}/sessions`, { timeout: 20_000 });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.data.sessions)).toBe(true);

    const update = await axios.put(
      `${baseUrl}/sessions/${sessionId}`,
      { name: "My Session" },
      { ...auth, timeout: 20_000 }
    );
    expect(update.status).toBe(200);
    expect(update.data.name).toBe("My Session");

    const msgs = await axios.get(`${baseUrl}/sessions/${sessionId}/messages`, {
      ...auth,
      timeout: 20_000,
    });
    expect(msgs.status).toBe(200);
    expect(Array.isArray(msgs.data.messages) || Array.isArray(msgs.data)).toBe(
      true
    );

    const del = await axios.delete(`${baseUrl}/sessions/${sessionId}`, {
      ...auth,
      timeout: 20_000,
    });
    expect(del.status).toBe(200);
  });

  it("Generate background job (auth)", async () => {
    const sessionId = randomUUID();
    const res = await axios.post(
      `${baseUrl}/generate/v2`,
      {
        prompt: "Say hi",
        session_id: sessionId,
        agent: "claude-code",
        cwd: "/home/appuser",
        model: "test-model",
        background: true,
      },
      { ...auth, timeout: 30_000 }
    );
    expect(res.status).toBe(202);
    expect(res.data).toHaveProperty("taskId");
  });
});
