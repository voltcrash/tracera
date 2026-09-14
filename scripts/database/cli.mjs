import { spawnSync } from "node:child_process";
import { rootDirectory } from "../environment/worktree.mjs";
import { bootstrapCluster, ensureDevelopmentDatabase, syncRuntimeRole } from "./bootstrap.mjs";
import {
  describeTarget,
  inspectContainer,
  loadDatabaseTarget,
  removeResources,
  startContainer,
  stopContainer,
  waitForHealthy,
} from "./container.mjs";

process.on("uncaughtException", failCleanly);
process.on("unhandledRejection", failCleanly);

const COMMANDS = {
  start: ["local", "test"],
  stop: ["local", "test"],
  status: ["local", "test"],
  migrate: ["local"],
  reset: ["local"],
};
const [command, flag, profile, ...extra] = process.argv.slice(2);

// Commands take no URLs or names: the target is always this worktree's generated resource.
if (
  !COMMANDS[command] ||
  flag !== "--profile" ||
  !COMMANDS[command].includes(profile) ||
  extra.length > 0
) {
  throw new Error(
    "Usage: node scripts/database/cli.mjs start|stop|status --profile local|test, or migrate|reset --profile local",
  );
}

const target = loadDatabaseTarget(profile);

if (command === "start") {
  const outcome = await startContainer(target);
  bootstrapCluster(target);
  if (profile === "local") {
    ensureDevelopmentDatabase(target);
    syncRuntimeRole(target);
  }
  console.error(`PostgreSQL ${outcome} and bootstrapped: ${describeTarget(target)}.`);
  if (profile === "local") console.error('Apply migrations with "vp run db:local:migrate".');
} else if (command === "stop") {
  console.error(`PostgreSQL ${stopContainer(target)}: ${describeTarget(target)}.`);
} else if (command === "status") {
  const state = inspectContainer(target);
  if (state?.running) await waitForHealthy(target);
  const summary = state ? (state.running ? `running (${state.health})` : "stopped") : "not created";
  console.log(`${describeTarget(target)}: ${summary}.`);
  if (!state?.running) process.exitCode = 1;
} else if (command === "migrate") {
  migrateLocal();
} else if (command === "reset") {
  removeResources(target);
  await startContainer(target);
  bootstrapCluster(target);
  ensureDevelopmentDatabase(target);
  console.error(`Recreated empty ${describeTarget(target)}.`);
  migrateLocal();
}

function migrateLocal() {
  const migration = spawnSync(
    process.execPath,
    [
      "scripts/environment/run.mjs",
      "--profile",
      "local",
      "--role",
      "migration",
      "--require-database",
      "--",
      "vp",
      "run",
      "@repo/db#db:migrate",
    ],
    { cwd: rootDirectory, stdio: "inherit" },
  );
  if (migration.status !== 0) {
    process.exitCode = migration.status ?? 1;
    return;
  }
  syncRuntimeRole(target);
  console.error("Migrations applied; runtime role credentials synchronized.");
}

function failCleanly(error) {
  console.error(
    `Tracera database error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
