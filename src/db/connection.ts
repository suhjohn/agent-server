import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema";
import { resolve } from "path";

// Environment variables with defaults
const getDatabasePath = (): string => {
  if (process.env.DATABASE_PATH) {
    return process.env.DATABASE_PATH;
  }

  // Default to data directory in user home
  const dataDir = process.env.HOME || "/home/appuser";
  return resolve(dataDir, "data", "agent_ts.db");
};

// Create the connection
const databasePath = getDatabasePath();
const client = new Database(databasePath);

// Enable WAL mode for better concurrency
client.pragma("journal_mode = WAL");

// Create drizzle instance
export const db = drizzle(client, { schema });

// Health check function
export const checkDatabaseConnection = async (): Promise<boolean> => {
  try {
    const result = client.prepare("SELECT 1 as test").get();
    return result !== undefined;
  } catch (error) {
    console.error("Database connection failed:", error);
    return false;
  }
};

// Graceful shutdown
export const closeDatabaseConnection = async (): Promise<void> => {
  client.close();
};
