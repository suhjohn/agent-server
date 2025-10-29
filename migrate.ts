import { db } from "./src/db/connection";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

// Run migrations
migrate(db, { migrationsFolder: "./drizzle" });

console.log("✅ Migrations completed");
process.exit(0);