import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export function loadEnvDocker(dir: string): Record<string, string> {
  const envPath = path.join(dir, ".env.docker");
  if (!fs.existsSync(envPath)) return {};
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v !== undefined) env[k] = String(v);
  }
  return env;
}


