import path from "node:path";
import { GenericContainer } from "testcontainers";
import { loadEnvDocker } from "./env";

export async function startAgentContainer() {
  const contextDir = path.resolve(__dirname, "../../../");
  const env = loadEnvDocker(contextDir);
  if (!env.API_KEY) env.API_KEY = "test-api-key-123";
  env.PRESERVE_SSH_ON_SHUTDOWN = "false";

  // Use an obscure internal container port, and tell the app via PORT
  const containerPort = 43123; // obscure
  env.PORT = String(containerPort);

  // Use the prebuilt image tag defined by package.json's docker:build ("agent")
  const imageName = "agent";

  const container = await new GenericContainer(imageName)
    .withExposedPorts(containerPort)
    .withEnvironment(env)
    .start();

  const baseUrl = `http://${container.getHost()}:${container.getMappedPort(
    containerPort
  )}`;

  const stop = () => container.stop({ timeout: 10_000 });
  return { baseUrl, stop, env, container };
}
