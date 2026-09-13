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

function embedding(primary: number, secondary = primary, weight = 1) {
  const values = Array.from({ length: database.EMBEDDING_DIMENSIONS }, () => 0);
  values[primary] = weight;
  values[secondary] = (values[secondary] ?? 0) + Math.sqrt(1 - weight * weight);
  return values;
}

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

function storedCheck(ownerUserId: string, claimEmbedding = embedding(7)) {
  return {
    rawInput: "Volcanic ash grounded flights across northern Europe",
    headline: "Volcanic ash grounds flights",
    inputEmbedding: embedding(3),
    traceraScore: { score: 72 },
    analysis: { claims: [], score: {} },
    claims: [
      {
        claimText: "Volcanic ash grounded flights across northern Europe",
        claimType: "factual_assertion",
        checkability: "checkable",
        verdict: "supported",
        confidence: 0.9,
        reasoning: ["Synthetic integration fixture"],
        evidenceQuality: 0.8,
        embedding: claimEmbedding,
      },
    ],
    ownerUserId,
  };
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

integrationTest("pgvector similarity and full-text search stay owner-scoped", async () => {
  const owner = await createUser();
  const otherOwner = await createUser();
  await database.persistCheck(storedCheck(owner));

  const related = await database.findRelatedClaimsByEmbedding(embedding(7, 8, 0.95), 0.9, 5, owner);
  assert.equal(related.length, 1);
  assert.ok(related[0] && related[0].similarity > 0.9 && related[0].similarity < 1);
  assert.deepEqual(
    await database.findRelatedClaimsByEmbedding(embedding(7, 8, 0.95), 0.9, 5, otherOwner),
    [],
  );

  assert.equal((await database.listChecks(1, 10, "volcanic flights", owner)).total, 1);
  assert.equal((await database.listChecks(1, 10, "earthquake", owner)).total, 0);
  assert.equal((await database.listChecks(1, 10, "volcanic flights", otherOwner)).total, 0);
});

integrationTest("failed transactions roll back every statement", async () => {
  const owner = await createUser();
  await assert.rejects(
    database.persistCheck(storedCheck(owner, [1, 2, 3])),
    /must have 1024 dimensions/,
  );
  assert.equal((await database.listChecks(1, 10, "", owner)).total, 0);

  const domain = `rollback-${randomUUID()}.example`;
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO domains (domain, trust_score) VALUES ($1, 0.5)", [domain]);
    await assert.rejects(
      client.query("INSERT INTO domains (domain, trust_score) VALUES ($1, 0.5)", [domain]),
      { code: "23505" },
    );
    await client.query("ROLLBACK");
  } finally {
    client.release(true);
  }
  const persisted = await database.pool.query("SELECT 1 FROM domains WHERE domain = $1", [domain]);
  assert.equal(persisted.rowCount, 0);
});

integrationTest("analysis admission and spend controls run under runtime grants", async () => {
  const userId = await createUser();
  const endpoint = "/api/analyze";
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
    "ALTER TABLE checks ADD COLUMN runtime_escalation text",
    "DROP TABLE claims",
    "TRUNCATE checks",
    "DELETE FROM checks",
    "UPDATE checks SET raw_input = raw_input",
    "DELETE FROM core_jobs",
    "SELECT * FROM core_decisions",
    "SELECT * FROM alert_subscriptions",
    "SELECT * FROM drizzle.__drizzle_migrations",
    "SET ROLE tracera_migrator",
  ];
  for (const statement of denied) {
    await assert.rejects(database.pool.query(statement), { code: "42501" }, statement);
  }
});
