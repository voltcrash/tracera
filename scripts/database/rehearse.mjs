import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTestRunDatabase } from "../../packages/environment/src/index.js";
import { rootDirectory } from "../environment/worktree.mjs";
import { bootstrapCluster, syncRuntimeRole } from "./bootstrap.mjs";
import {
  describeTarget,
  loadDatabaseTarget,
  recentServerErrors,
  removeResources,
  startContainer,
} from "./container.mjs";
import { createRunDatabase, dropRunDatabase, newRunId, pg, withProvisioner } from "./provision.mjs";
import { RUNTIME_TABLE_GRANTS } from "./runtime-grants.mjs";

process.on("uncaughtException", failCleanly);
process.on("unhandledRejection", failCleanly);

const databaseDirectory = join(rootDirectory, "packages/db");
const target = loadDatabaseTarget("test");

// A fresh tmpfs cluster per rehearsal: migration 0024 must take its create-role path.
removeResources(target);
await startContainer(target);
bootstrapCluster(target);
const runId = newRunId();
const databaseName = await createRunDatabase(target, runId);
log(`Provisioned empty run database ${databaseName} in ${describeTarget(target)}.`);

const migrationEnvironment = withTestRunDatabase(target.environments.migration, runId);
const runtimeEnvironment = withTestRunDatabase(target.environments.runtime, runId);

try {
  migrate("first");
  syncRuntimeRole(target);
  const first = await asMigrator(fingerprint);
  const journal = verifyJournal(first.migrations);
  log(`Applied ${journal.length} journal migrations; hashes and timestamps match the files.`);

  migrate("repeat");
  const repeated = await asMigrator(fingerprint);
  assert.deepEqual(repeated, first, "Repeated migration changed migration history or schema.");
  log("Repeated migration was a no-op (identical migration rows and schema fingerprint).");

  await asMigrator(auditRuntimePrivileges);
  log(
    `Runtime privileges match the reviewed map for ${Object.keys(RUNTIME_TABLE_GRANTS).length} tables.`,
  );

  runRuntimeSuite();
} finally {
  await dropRunDatabase(target, runId);
  const remaining = await withProvisioner(target, (client) =>
    client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]),
  );
  assert.equal(remaining.rowCount, 0, `Run database ${databaseName} was not dropped.`);
  log(`Dropped run database ${databaseName}.`);
}
log("PostgreSQL rehearsal passed.");

function migrate(label) {
  const result = spawnSync("vp", ["run", "@repo/db#db:migrate"], {
    cwd: rootDirectory,
    env: { ...process.env, ...migrationEnvironment },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `The ${label} migration failed. Recent server errors:\n${recentServerErrors(target)}`,
    );
  }
}

async function asMigrator(operation) {
  const client = new pg.Client({ connectionString: migrationEnvironment.DATABASE_MIGRATOR_URL });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function fingerprint(client) {
  const migrations = await client.query(
    "SELECT id, hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id",
  );
  const schema = await client.query(`
    SELECT md5(string_agg(entry, E'\\n' ORDER BY entry)) AS digest FROM (
      SELECT format('column %s.%s %s %s %s', table_name, column_name, data_type, is_nullable, column_default)
        FROM information_schema.columns WHERE table_schema = 'public'
      UNION ALL SELECT format('index %s', indexdef) FROM pg_indexes WHERE schemaname = 'public'
      UNION ALL SELECT format('constraint %s %s', conname, pg_get_constraintdef(oid))
        FROM pg_constraint WHERE connamespace = 'public'::regnamespace
      UNION ALL SELECT format('acl %s %s', relname, relacl)
        FROM pg_class WHERE relnamespace = 'public'::regnamespace
    ) entries(entry)`);
  return { migrations: migrations.rows, schema: schema.rows[0].digest };
}

/** Drizzle records a SHA-256 of each file and its journal timestamp; verify both. */
function verifyJournal(appliedRows) {
  const migrationsDirectory = join(databaseDirectory, "drizzle");
  const { entries } = JSON.parse(
    readFileSync(join(migrationsDirectory, "meta/_journal.json"), "utf8"),
  );
  const files = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.deepEqual(
    files,
    entries.map((entry) => `${entry.tag}.sql`).sort(),
    "Migration files and journal entries differ.",
  );
  assert.equal(appliedRows.length, entries.length, "Not every journal migration was applied.");
  entries.forEach((entry, index) => {
    const content = readFileSync(join(migrationsDirectory, `${entry.tag}.sql`), "utf8");
    const row = appliedRows[index];
    assert.equal(row.hash, createHash("sha256").update(content).digest("hex"), `${entry.tag} hash`);
    assert.equal(Number(row.created_at), entry.when, `${entry.tag} journal timestamp`);
  });
  return entries;
}

async function auditRuntimePrivileges(client) {
  const tables = await client.query(`
    SELECT c.relname,
           COALESCE(array_agg(p.privilege_type::text ORDER BY p.privilege_type)
             FILTER (WHERE p.privilege_type IS NOT NULL), '{}') AS privileges,
           bool_or(COALESCE(p.is_grantable, false)) AS grantable
      FROM pg_class c
      LEFT JOIN LATERAL aclexplode(c.relacl) p ON p.grantee = 'tracera_runtime'::regrole
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
     GROUP BY c.relname`);
  const actual = Object.fromEntries(tables.rows.map((row) => [row.relname, row.privileges]));
  const expected = Object.fromEntries(
    Object.entries(RUNTIME_TABLE_GRANTS).map(([table, privileges]) => [
      table,
      [...privileges].sort(),
    ]),
  );
  assert.deepEqual(
    actual,
    expected,
    "tracera_runtime table privileges differ from the reviewed map.",
  );
  assert.ok(!tables.rows.some((row) => row.grantable), "tracera_runtime holds a grant option.");

  const columnGrants = await client.query(`
    SELECT count(*)::int AS count FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      CROSS JOIN LATERAL aclexplode(a.attacl) p
     WHERE c.relnamespace = 'public'::regnamespace AND p.grantee = 'tracera_runtime'::regrole`);
  assert.equal(columnGrants.rows[0].count, 0, "tracera_runtime has column-level grants.");

  const scope = await client.query(`
    SELECT has_schema_privilege('tracera_runtime', 'public', 'USAGE') AS public_usage,
           has_schema_privilege('tracera_runtime', 'public', 'CREATE') AS public_create,
           has_schema_privilege('tracera_runtime', 'drizzle', 'USAGE') AS migrations_usage,
           has_database_privilege('tracera_runtime', current_database(), 'CONNECT') AS connect,
           has_database_privilege('tracera_runtime', current_database(), 'CREATE') AS database_create,
           has_database_privilege('tracera_runtime', current_database(), 'TEMP') AS temporary,
           has_database_privilege('tracera_runtime', 'postgres', 'CONNECT') AS maintenance_connect,
           r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls, r.rolinherit,
           (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS memberships
      FROM pg_roles r WHERE r.rolname = 'tracera_runtime'`);
  assert.deepEqual(scope.rows[0], {
    public_usage: true,
    public_create: false,
    migrations_usage: false,
    connect: true,
    database_create: false,
    temporary: false,
    maintenance_connect: false,
    rolsuper: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolreplication: false,
    rolbypassrls: false,
    rolinherit: false,
    memberships: 0,
  });
}

function runRuntimeSuite() {
  const reportDirectory = mkdtempSync(join(tmpdir(), "tracera-rehearsal-"));
  const reportPath = join(reportDirectory, "report.json");
  try {
    const result = spawnSync(
      "vp",
      [
        "test",
        "--run",
        "test/postgres.integration.test.ts",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${reportPath}`,
      ],
      { cwd: databaseDirectory, env: { ...process.env, ...runtimeEnvironment }, stdio: "inherit" },
    );
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const skipped = report.numPendingTests + report.numTodoTests;
    log(
      `Runtime integration suite: ${report.numPassedTests} passed, ${report.numFailedTests} failed, ${skipped} skipped.`,
    );
    // A required integration suite that executes nothing is a failure.
    if (
      result.status !== 0 ||
      report.numFailedTests > 0 ||
      skipped > 0 ||
      report.numPassedTests === 0
    ) {
      throw new Error("The runtime PostgreSQL integration suite did not pass completely.");
    }
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

function log(message) {
  console.error(`[db:rehearse] ${message}`);
}

function failCleanly(error) {
  console.error(
    `Tracera database rehearsal failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
