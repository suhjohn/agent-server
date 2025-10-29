/// <reference types="node" />
import type { Config } from "drizzle-kit";
import { resolve } from "path";

const getDatabasePath = (): string => {
  if (process.env.DATABASE_PATH) {
    return process.env.DATABASE_PATH;
  }

  // Default to data directory in user home
  const dataDir = process.env.HOME || "/home/appuser";
  return resolve(dataDir, "data", "agent_ts.db");
};

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: getDatabasePath(),
  },
  verbose: true,
  strict: true,
} satisfies Config;
