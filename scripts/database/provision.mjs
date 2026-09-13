import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  assertEnvironmentConfiguration,
  withTestRunDatabase,
} from "../../packages/environment/src/index.js";

const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
export const pg = require("pg");

export function newRunId() {
  return randomBytes(6).toString("hex");
}

/** Derives a run database name through the environment validator, never from input URLs. */
export function runDatabaseName(target, runId) {
  const environment = withTestRunDatabase(target.environments.migration, runId);
  return decodeURIComponent(new URL(environment.DATABASE_MIGRATOR_URL).pathname.slice(1));
}

export async function createRunDatabase(target, runId) {
  const name = runDatabaseName(target, runId);
  await withProvisioner(target, async (client) => {
    await client.query(
      `CREATE DATABASE ${identifier(name)} OWNER tracera_migrator TEMPLATE template1`,
    );
    await client.query("SET ROLE tracera_migrator");
    await client.query(`REVOKE ALL ON DATABASE ${identifier(name)} FROM PUBLIC`);
    await client.query("RESET ROLE");
  });
  return name;
}

export async function dropRunDatabase(target, runId) {
  const name = runDatabaseName(target, runId);
  await withProvisioner(target, async (client) => {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
    await client.query("SET ROLE tracera_migrator");
    await client.query(`DROP DATABASE IF EXISTS ${identifier(name)}`);
    await client.query("RESET ROLE");
  });
  return name;
}

export async function withProvisioner(target, operation) {
  if (target.profile !== "test") throw new Error("Run databases exist only in the test cluster.");
  const environment = target.environments["test-provisioning"];
  assertEnvironmentConfiguration(environment, "test-provisioning");
  const client = new pg.Client({ connectionString: environment.TEST_DATABASE_PROVISIONER_URL });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

function identifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}
