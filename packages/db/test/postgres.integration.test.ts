import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runContextExample, type RunContext } from "@repo/contracts/core-v2";
import pg from "pg";
import { afterAll, test } from "vite-plus/test";
import { CoreStorageRepository, type CoreAccessScope, type CorePool } from "../src/core/index.js";
import * as database from "../src/index.js";

// Runs only inside `vp run db:rehearse`, which provisions a migrated run database
// and passes the sealed test-profile runtime environment.
const enabled = process.env.TRACERA_PROFILE === "test" && Boolean(process.env.DATABASE_URL);
const integrationTest = enabled ? test : test.skip;

afterAll(async () => {
  if (enabled) await database.closeDatabase();
});

const limits = {
  userRateLimit: 5,
  ipRateLimit: 5,
  rateWindowSeconds: 60,
  userConcurrencyLimit: 1,
  ipConcurrencyLimit: 5,
  dailyQuota: 10,
  forceReanalysisCooldownSeconds: 60,
  leaseSeconds: 60,
  idempotencyTtlSeconds: 600,
};

async function createUser() {
  const suffix = randomUUID();
  const result = await database.pool.query<{ id: string }>(
    "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
    [`Synthetic ${suffix}`, `synthetic-${suffix}@tracera.test`],
  );
  const id = result.rows[0]?.id;
  assert.ok(id);
  return id;
}

integrationTest("runtime uses node-postgres as the unprivileged runtime role", async () => {
  assert.equal(database.activeDatabaseTransport(), "node-postgres");
  assert.ok(database.pool instanceof pg.Pool);
  const result = await database.pool.query<{
    role: string;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT current_user AS role, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
  );
  assert.deepEqual(result.rows[0], {
    role: "tracera_runtime",
    rolsuper: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolbypassrls: false,
  });
});

integrationTest("analysis admission and spend controls run under runtime grants", async () => {
  const userId = await createUser();
  const endpoint = "/api/tracera/v2/analyze";
  const idempotencyKey = randomUUID();
  const request = {
    userId,
    ipHash: `ip-${randomUUID()}`,
    endpoint,
    idempotencyKey,
    requestHash: "request-hash",
    forceReanalysis: false,
    forceInputHash: "input-hash",
    limits,
  };
  const admission = await database.beginAnalysisAdmission(request);
  assert.equal(admission.kind, "admitted");
  assert.ok(admission.kind === "admitted");

  const concurrent = await database.beginAnalysisAdmission({
    ...request,
    idempotencyKey: randomUUID(),
  });
  assert.equal(concurrent.kind === "rejected" && concurrent.reason, "user_concurrency_limit");

  await database.finishAnalysisAdmission({
    userId,
    endpoint,
    idempotencyKey,
    leaseId: admission.leaseId,
    responseBody: { synthetic: true },
    responseStatus: 200,
    idempotencyTtlSeconds: limits.idempotencyTtlSeconds,
  });
  const replay = await database.beginAnalysisAdmission(request);
  assert.deepEqual(replay, {
    kind: "replay",
    responseBody: { synthetic: true },
    responseStatus: 200,
  });

  const spend = await database.reserveProviderSpend({
    providerKey: `fixture-${randomUUID()}`,
    estimatedUsd: 0.01,
    dailyBudgetUsd: 1,
  });
  assert.ok(spend.allowed);
  await database.settleProviderSpend({ reservationId: spend.reservation.id, actualUsd: 0.005 });
});

integrationTest("Core storage operations run under the runtime grants from 0029", async () => {
  const suffix = randomUUID();
  const context: RunContext = {
    ...structuredClone(runContextExample),
    runId: `runtime-grants-${suffix}`,
    tenantId: `tenant-${suffix}`,
    ownerUserId: `owner-${suffix}`,
    visibility: "private",
  };
  const scope: CoreAccessScope = {
    tenantId: context.tenantId,
    ownerUserId: context.ownerUserId,
    visibility: context.visibility,
  };
  const repository = new CoreStorageRepository(database.pool as unknown as CorePool);

  const job = await repository.enqueue({
    context,
    stage: "normalize_input",
    payload: { synthetic: true },
    maxAttempts: 2,
  });
  assert.equal(job.created, true);
  const lease = await repository.acquireLease({ scope, workerId: "worker-a", leaseSeconds: 30 });
  assert.ok(lease);
  const checkpointHash = `sha256:${"0".repeat(64)}`;
  await repository.checkpoint({
    scope,
    runId: context.runId,
    stage: lease.stage,
    attempt: lease.attempt,
    fencingToken: lease.fencingToken,
    checkpointHash,
    payloadJson: "{}",
  });
  assert.deepEqual(
    await repository.readCheckpoint({ scope, runId: context.runId, stage: lease.stage }),
    { checkpointHash, payloadJson: "{}" },
  );
  const [outbox] = await repository.readPendingOutbox({ scope, limit: 10 });
  assert.ok(outbox);
  assert.equal(await repository.markOutboxPublished({ scope, id: outbox.id }), true);
  assert.equal(
    await repository.requestCancellation({
      scope,
      runId: context.runId,
      reason: "operator_request",
    }),
    true,
  );
});

integrationTest("runtime cannot change schema, escalate, or delete protected rows", async () => {
  const denied = [
    "CREATE TABLE runtime_escalation (id integer)",
    "CREATE TEMP TABLE runtime_scratch (id integer)",
    "CREATE SCHEMA runtime_escalation",
    "CREATE EXTENSION IF NOT EXISTS pg_trgm",
    "ALTER TABLE core_runs ADD COLUMN runtime_escalation text",
    "DROP TABLE core_report_claims",
    "TRUNCATE core_runs",
    "DELETE FROM core_runs",
    "DELETE FROM core_jobs",
    "SELECT * FROM core_decisions",
    "SELECT * FROM drizzle.__drizzle_migrations",
    "SET ROLE tracera_migrator",
  ];
  for (const statement of denied) {
    await assert.rejects(database.pool.query(statement), { code: "42501" }, statement);
  }
});
