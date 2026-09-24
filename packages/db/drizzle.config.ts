import { assertEnvironmentConfiguration } from "@repo/environment";
import { defineConfig } from "drizzle-kit";

assertEnvironmentConfiguration(process.env, "migration");
const databaseUrl = process.env.DATABASE_MIGRATOR_URL;
if (!databaseUrl) throw new Error("DATABASE_MIGRATOR_URL is required for database migrations.");

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/schema.ts", "./src/analysis/schema.ts"],
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
});
