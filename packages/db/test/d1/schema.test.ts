import { drizzle } from "drizzle-orm/d1";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { users } from "../../src/schema.js";
import { createTestRuntime, seedUser } from "./runtime.js";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
beforeAll(async () => {
  runtime = await createTestRuntime();
});
afterAll(async () => {
  await runtime?.dispose();
});

test("the real baseline creates all 21 live tables without retired execution tables", async () => {
  const rows = await runtime.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'",
    )
    .all<{ name: string }>();
  const names = rows.results.map((row) => row.name);
  expect(names).toHaveLength(21);
  for (const name of [
    "users",
    "sessions",
    "accounts",
    "verifications",
    "core_runs",
    "core_stage_checkpoints",
    "core_snapshots",
    "core_report_versions",
    "analysis_leases",
    "ai_provider_spend",
  ])
    expect(names).toContain(name);
  for (const name of ["core_jobs", "core_outbox", "core_snapshot_embeddings"])
    expect(names).not.toContain(name);
  const columns = await runtime.db
    .prepare("PRAGMA table_info(core_stage_attempts)")
    .all<{ name: string }>();
  expect(columns.results.some((column) => column.name.startsWith("lease_"))).toBe(false);
});

test("Drizzle decodes SQLite millisecond timestamps and boolean columns", async () => {
  await seedUser(runtime.db, "mapping-user");
  const rows = await drizzle(runtime.db).select().from(users);
  const user = rows.find((row) => row.id === "mapping-user")!;
  expect(user.createdAt).toBeInstanceOf(Date);
  expect(user.createdAt.getTime()).toBe(0);
  expect(user.emailVerified).toBe(false);
});

test("D1 rolls back the whole batch when a uniqueness constraint fails", async () => {
  await expect(
    runtime.db.batch([
      runtime.db.prepare(
        "INSERT INTO users(id,name,email,created_at,updated_at) VALUES('atomic-first','First','same@tracera.local',0,0)",
      ),
      runtime.db.prepare(
        "INSERT INTO users(id,name,email,created_at,updated_at) VALUES('atomic-second','Second','same@tracera.local',0,0)",
      ),
    ]),
  ).rejects.toThrow();
  expect(
    await runtime.db
      .prepare("SELECT count(*) AS count FROM users WHERE id IN ('atomic-first','atomic-second')")
      .first("count"),
  ).toBe(0);
});

test("OAuth account identity is unique across users", async () => {
  await seedUser(runtime.db, "account-first");
  await seedUser(runtime.db, "account-second");
  await runtime.db
    .prepare(
      "INSERT INTO accounts(id,account_id,provider_id,user_id,created_at,updated_at) VALUES('account-1','github-id','github','account-first',0,0)",
    )
    .run();
  await expect(
    runtime.db
      .prepare(
        "INSERT INTO accounts(id,account_id,provider_id,user_id,created_at,updated_at) VALUES('account-2','github-id','github','account-second',0,0)",
      )
      .run(),
  ).rejects.toThrow();
});

test("D1 separates spend counters by provider, source and UTC day", async () => {
  for (const source of ["platform", "user"])
    await runtime.db
      .prepare(
        "INSERT INTO ai_provider_spend(provider_key,key_source,period_start,budget_micros,updated_at) VALUES(?,?,?,?,?)",
      )
      .bind("gemini", source, "2026-10-12", 1_000_000, 0)
      .run();
  expect(
    await runtime.db
      .prepare("SELECT count(*) FROM ai_provider_spend WHERE provider_key='gemini'")
      .first("count(*)"),
  ).toBe(2);
  await expect(
    runtime.db
      .prepare("UPDATE ai_provider_spend SET reserved_micros=-1 WHERE key_source='platform'")
      .run(),
  ).rejects.toThrow();
});

test("checkpoint foreign keys enforce the run's complete ownership scope", async () => {
  await runtime.db
    .prepare(
      "INSERT INTO core_runs(run_id,tenant_id,owner_user_id,visibility,input_hash,context_hash,as_of_time,execution_mode,versions,budget,cancellation,audit_sink_id,created_at,updated_at) VALUES('scope-run','tenant','owner','private','input-hash','context-hash',0,'fixture','{}','{}','{}','audit',0,0)",
    )
    .run();
  await expect(
    runtime.db
      .prepare(
        "INSERT INTO core_stage_checkpoints(run_id,tenant_id,owner_user_id,visibility,stage,attempt,fencing_token,checkpoint_hash,payload_json,created_at,updated_at) VALUES('scope-run','different-tenant','owner','private','normalize_input',1,'fence','hash','{}',0,0)",
      )
      .run(),
  ).rejects.toThrow();
  expect(
    await runtime.db.prepare("SELECT count(*) FROM core_stage_checkpoints").first("count(*)"),
  ).toBe(0);
});

test("snapshot payloads require exactly one inline value or R2 pointer", async () => {
  await expect(
    runtime.db
      .prepare(
        "INSERT INTO core_snapshots(snapshot_id,tenant_id,owner_user_id,visibility,content_hash,snapshot,snapshot_hash,snapshot_blob_uri,blob_status,created_at) VALUES('conflicting-storage','tenant','owner','private','hash','{}','hash','r2://payloads/hash','unavailable',0)",
      )
      .run(),
  ).rejects.toThrow();
  await expect(
    runtime.db
      .prepare(
        "INSERT INTO core_snapshots(snapshot_id,tenant_id,owner_user_id,visibility,content_hash,snapshot_hash,blob_status,created_at) VALUES('missing-storage','tenant','owner','private','hash','hash','unavailable',0)",
      )
      .run(),
  ).rejects.toThrow();
});
