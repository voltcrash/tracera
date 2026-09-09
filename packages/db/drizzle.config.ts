import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

const rootEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnvPath)) loadEnvFile(rootEnvPath);

const databaseUrl = process.env.DATABASE_MIGRATOR_URL;
if (!databaseUrl) throw new Error("DATABASE_MIGRATOR_URL is required for database migrations.");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
});
