import { spawnSync } from "node:child_process";
import { inspectContainer, loadDatabaseTarget } from "../database/container.mjs";
import { rootDirectory } from "../environment/worktree.mjs";

const commands = new Set(["setup", "up", "reset", "down", "integration"]);
const [command, ...extra] = process.argv.slice(2);

if (!commands.has(command) || extra.length > 0) {
  throw new Error("Usage: node scripts/local/workflow.mjs setup|up|reset|down|integration");
}

if (command === "setup") {
  runAll(["env:setup", "db:local:start", "db:local:migrate", "db:local:status"]);
} else if (command === "up") {
  runAll(["db:local:start", "db:local:status"]);
} else if (command === "reset") {
  run("db:local:reset");
} else if (command === "down") {
  run("db:local:stop");
} else {
  runIntegration();
}

function runIntegration() {
  run("env:setup");
  const localTarget = loadDatabaseTarget("local");
  const leaveRunning = inspectContainer(localTarget)?.running === true;

  try {
    runAll([
      "db:local:start",
      "db:local:migrate",
      "db:rehearse",
      "test:core-storage",
      "test:auth-browser",
      "test:offline-analysis",
      "evaluate:core:fixture",
    ]);
    console.error("[test:integration] All required local integration suites passed.");
  } finally {
    if (!leaveRunning) run("db:local:stop", { allowFailure: true });
  }
}

function runAll(scripts) {
  for (const script of scripts) run(script);
}

function run(script, { allowFailure = false } = {}) {
  console.error(`[local-workflow] vp run ${script}`);
  const result = spawnSync("vp", ["run", script], {
    cwd: rootDirectory,
    stdio: "inherit",
  });
  if (result.error) throw new Error(`Unable to run ${script}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${script} failed with exit code ${result.status ?? "unknown"}.`);
  }
}
