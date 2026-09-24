import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { loadProfileEnvironment } from "../../packages/environment/src/loader.js";
import { containerTarget, requireHealthyTarget } from "../database/container.mjs";
import { rootDirectory } from "../environment/worktree.mjs";

const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { Client } = require("pg");
const fixtureEmails = ["ada@tracera.local", "grace@tracera.local"];

const migration = loadProfileEnvironment({
  rootDirectory,
  profile: "local",
  role: "migration",
  inheritedEnv: {},
});
const runtime = loadProfileEnvironment({
  rootDirectory,
  profile: "local",
  role: "runtime",
  inheritedEnv: {},
});
await requireHealthyTarget(containerTarget(runtime));

await cleanupFixtures();
let result;
try {
  result = spawnSync(
    process.execPath,
    [
      "scripts/environment/run.mjs",
      "--profile",
      "local",
      "--role",
      "runtime",
      "--require-database",
      "--",
      "vp",
      "run",
      "--filter",
      "web",
      "test:auth-browser",
    ],
    { cwd: rootDirectory, stdio: "inherit" },
  );
} finally {
  await cleanupFixtures();
}

if (result?.status !== 0) process.exit(result?.status ?? 1);

async function cleanupFixtures() {
  const client = new Client({ connectionString: migration.DATABASE_MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM users WHERE email = ANY($1::text[])", [fixtureEmails]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}
