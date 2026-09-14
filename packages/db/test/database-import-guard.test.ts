import assert from "node:assert/strict";
import { test } from "vite-plus/test";

test("database import rejects an inherited unprofiled target before pool construction", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousProfile = process.env.TRACERA_PROFILE;
  const previousRole = process.env.TRACERA_CONFIG_ROLE;
  process.env.DATABASE_URL = "postgresql://tracera_runtime:do-not-use@production.example/tracera";
  delete process.env.TRACERA_PROFILE;
  delete process.env.TRACERA_CONFIG_ROLE;

  try {
    await assert.rejects(import("../src/index.js"), /TRACERA_PROFILE/);
  } finally {
    restoreEnvironment("DATABASE_URL", previousDatabaseUrl);
    restoreEnvironment("TRACERA_PROFILE", previousProfile);
    restoreEnvironment("TRACERA_CONFIG_ROLE", previousRole);
  }
});

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
