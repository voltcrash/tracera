import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnvironmentSeal,
  withTestRunDatabase,
} from "../../packages/environment/src/index.js";
import { rootDirectory } from "../environment/worktree.mjs";
import { bootstrapCluster, syncRuntimeRole } from "./bootstrap.mjs";
import {
  describeTarget,
  loadDatabaseTarget,
  recentServerErrors,
  removeResources,
  startContainer,
} from "./container.mjs";
import { createRunDatabase, dropRunDatabase, newRunId } from "./provision.mjs";

const databaseDirectory = join(rootDirectory, "packages/db");
const lockDirectory = join(rootDirectory, ".tracera", "core-storage-test.lock");
let target;
let runId;
let databaseCreated = false;

if (process.argv.length > 2) {
  throw new Error("test:core-storage accepts no database URLs, names, or other arguments.");
}
acquireLock();
try {
  target = loadDatabaseTarget("test");
  removeResources(target);
  await startContainer(target);
  bootstrapCluster(target);
  runId = newRunId();
  const databaseName = await createRunDatabase(target, runId);
  databaseCreated = true;
  log(`Provisioned empty run database ${databaseName} in ${describeTarget(target)}.`);

  const migrationEnvironment = withTestRunDatabase(target.environments.migration, runId);
  const runtimeEnvironment = analysisStorageEnvironment(
    withTestRunDatabase(target.environments.runtime, runId),
  );
  migrate(migrationEnvironment);
  syncRuntimeRole(target);
  runSuite(runtimeEnvironment);
  log("Core storage PostgreSQL validation passed.");
} catch (error) {
  console.error(
    `Core storage PostgreSQL validation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  try {
    if (target && runId && databaseCreated) {
      const databaseName = await dropRunDatabase(target, runId);
      log(`Dropped run database ${databaseName}.`);
    }
  } catch (error) {
    console.error(
      `Core storage database cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    try {
      if (target) removeResources(target);
    } finally {
      rmSync(lockDirectory, { recursive: true, force: true });
    }
  }
}

function acquireLock() {
  try {
    mkdirSync(lockDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(
        "Another Core storage validation owns this worktree's disposable test cluster.",
      );
    }
    throw error;
  }
}

function analysisStorageEnvironment(environment) {
  const derived = {
    ...environment,
    CORE_STORAGE_TEST_DATABASE_URL: environment.DATABASE_URL,
  };
  derived.TRACERA_CONFIG_SEAL = createEnvironmentSeal(derived);
  return derived;
}

function migrate(environment) {
  const result = spawnSync("vp", ["run", "@repo/db#db:migrate"], {
    cwd: rootDirectory,
    env: { ...process.env, ...environment },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Migration failed. Recent server errors:\n${recentServerErrors(target)}`);
  }
}

function runSuite(environment) {
  const reportDirectory = mkdtempSync(join(tmpdir(), "tracera-core-storage-"));
  const reportPath = join(reportDirectory, "report.json");
  try {
    const result = spawnSync(
      "vp",
      [
        "test",
        "--run",
        "test/core-storage.integration.test.ts",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${reportPath}`,
      ],
      { cwd: databaseDirectory, env: { ...process.env, ...environment }, stdio: "inherit" },
    );
    if (!existsSync(reportPath)) {
      throw new Error("The Core storage suite exited without producing a test report.");
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const skipped = report.numPendingTests + report.numTodoTests;
    log(
      `Core storage integration suite: ${report.numPassedTests} passed, ${report.numFailedTests} failed, ${skipped} skipped.`,
    );
    if (
      result.status !== 0 ||
      report.numFailedTests > 0 ||
      skipped > 0 ||
      report.numPassedTests === 0
    ) {
      throw new Error("The Core storage integration suite did not pass completely.");
    }
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

function log(message) {
  console.error(`[test:core-storage] ${message}`);
}
