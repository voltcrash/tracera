import { superuserSql } from "./container.mjs";

const MIGRATOR = "tracera_migrator";
const RUNTIME = "tracera_runtime";
const PROVISIONER = "tracera_test_provisioner";

/**
 * Idempotently applies cluster-level privileges that migrations cannot own:
 * extensions, login roles, and their generated passwords. Table grants remain
 * exclusively in reviewed migrations.
 *
 * The runtime role is deliberately not created here. Migration 0024 creates it
 * as the migrator; its existing-role branch sets NOSUPERUSER, which vanilla
 * PostgreSQL permits only to superusers. Each cluster therefore hosts exactly
 * one migrated Tracera database lifecycle.
 */
export function bootstrapCluster(target) {
  const statements = [
    "ALTER ROLE postgres PASSWORD NULL;",
    "SET password_encryption = 'scram-sha-256';",
    ensureRole(
      MIGRATOR,
      "LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
      target.passwords.get(MIGRATOR),
    ),
    "REVOKE ALL ON DATABASE postgres FROM PUBLIC;",
    "REVOKE ALL ON DATABASE template1 FROM PUBLIC;",
  ];
  if (target.profile === "test") {
    statements.push(
      ensureRole(
        PROVISIONER,
        "LOGIN NOSUPERUSER CREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS",
        target.passwords.get(PROVISIONER),
      ),
      // CREATE/DROP DATABASE for migrator-owned run databases requires SET on the
      // owner. This grant exists only in the disposable test cluster.
      `GRANT ${MIGRATOR} TO ${PROVISIONER} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;`,
      `GRANT pg_signal_backend TO ${PROVISIONER};`,
      `GRANT CONNECT ON DATABASE postgres TO ${PROVISIONER};`,
    );
  }
  superuserSql(target, "postgres", statements.join("\n"));
  // pgvector is not a trusted extension. Installing it in the template lets
  // non-superuser owners create databases whose migrations find it present.
  superuserSql(target, "template1", "CREATE EXTENSION IF NOT EXISTS vector;");
}

/** Sets the generated runtime password after migrations have created the role. */
export function syncRuntimeRole(target) {
  const password = target.passwords.get(RUNTIME);
  if (!password) throw new Error(`Generated password for ${RUNTIME} is missing.`);
  superuserSql(
    target,
    "postgres",
    [
      "SET password_encryption = 'scram-sha-256';",
      `SELECT format('ALTER ROLE ${RUNTIME} WITH PASSWORD %L', ${literal(password)})`,
      `  WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = '${RUNTIME}')\\gexec`,
    ].join("\n"),
  );
}

export function ensureDevelopmentDatabase(target) {
  superuserSql(
    target,
    "postgres",
    [
      `SELECT format('CREATE DATABASE %I OWNER ${MIGRATOR} TEMPLATE template1', ${literal(target.databaseName)})`,
      `  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${literal(target.databaseName)})\\gexec`,
      `REVOKE ALL ON DATABASE ${identifier(target.databaseName)} FROM PUBLIC;`,
    ].join("\n"),
  );
}

function ensureRole(name, attributes, password) {
  if (!password) throw new Error(`Generated password for ${name} is missing.`);
  return [
    `SELECT 'CREATE ROLE ${name}' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${name}')\\gexec`,
    `ALTER ROLE ${name} WITH ${attributes} PASSWORD ${literal(password)};`,
  ].join("\n");
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function identifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
