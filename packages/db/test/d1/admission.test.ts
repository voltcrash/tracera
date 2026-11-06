import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { runContextExample } from "@repo/contracts/analysis";
import { createD1AnalysisRepository } from "../../src/repository.js";
import { createD1MaintenanceRepository } from "../../src/maintenance.js";
import { readFile } from "node:fs/promises";
import { createD1AdmissionRepository } from "../../src/admission.js";
import { createTestRuntime, seedUser } from "./runtime.js";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
let now: number;
beforeEach(async () => {
  runtime = await createTestRuntime();
  await seedUser(runtime.db);
  now = Date.parse("2026-10-12T12:00:00Z");
});
afterEach(async () => {
  await runtime?.dispose();
});
const repo = () =>
  createD1AdmissionRepository({ database: runtime.db, bucket: runtime.bucket, now: () => now });
const limits = {
  userRateLimit: 20,
  ipRateLimit: 20,
  rateWindowSeconds: 60,
  userConcurrencyLimit: 1,
  ipConcurrencyLimit: 5,
  dailyQuota: 10,
  forceReanalysisCooldownSeconds: 60,
  leaseSeconds: 60,
  idempotencyTtlSeconds: 600,
};
const request = (key: string) => ({
  userId: "user-1",
  ipHash: "ip-1",
  endpoint: "/analyze",
  idempotencyKey: key,
  requestHash: "request-hash",
  forceReanalysis: false,
  forceInputHash: "input-hash",
  limits,
});

test("user keys bypass a spent daily quota while retaining rate and concurrency limits", async () => {
  const repository = repo();
  const settings = { ...limits, dailyQuota: 1, userRateLimit: 2, userConcurrencyLimit: 2 };
  const first = await repository.beginAnalysisAdmission({
    ...request("platform"),
    limits: settings,
  });
  expect(first.kind).toBe("admitted");
  expect(
    await repository.beginAnalysisAdmission({
      ...request("platform-over-quota"),
      limits: settings,
    }),
  ).toMatchObject({ kind: "rejected", reason: "daily_quota" });
  expect(
    await repository.beginAnalysisAdmission({
      ...request("personal"),
      limits: settings,
      keySource: "user",
    }),
  ).toMatchObject({ kind: "admitted" });
  expect(
    await runtime.db
      .prepare("SELECT request_count FROM analysis_daily_quotas")
      .first("request_count"),
  ).toBe(1);
  expect(
    await repository.beginAnalysisAdmission({
      ...request("personal-rate-limited"),
      limits: settings,
      keySource: "user",
    }),
  ).toMatchObject({ kind: "rejected", reason: "user_rate_limit" });
  expect(
    await repository.beginAnalysisAdmission({
      ...request("personal-concurrency-limited"),
      limits: { ...settings, userRateLimit: 20 },
      keySource: "user",
    }),
  ).toMatchObject({ kind: "rejected", reason: "user_concurrency_limit" });
});

test("one atomic admission batch limits concurrent work without charging rejected requests", async () => {
  const repository = repo();
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      repository.beginAnalysisAdmission(request(`request-${i}`)),
    ),
  );
  expect(results.filter((result) => result.kind === "admitted")).toHaveLength(1);
  expect(
    results.filter(
      (result) => result.kind === "rejected" && result.reason === "user_concurrency_limit",
    ),
  ).toHaveLength(11);
  expect(
    await runtime.db
      .prepare("SELECT request_count FROM analysis_daily_quotas")
      .first("request_count"),
  ).toBe(1);
  expect(
    await runtime.db.prepare("SELECT count(*) FROM analysis_idempotency_keys").first("count(*)"),
  ).toBe(1);
});

test("idempotency claims reject duplicate active requests and changed input", async () => {
  const repository = repo();
  const first = await repository.beginAnalysisAdmission(request("same"));
  expect(first.kind).toBe("admitted");
  const duplicate = await repository.beginAnalysisAdmission(request("same"));
  expect(duplicate.kind === "rejected" && duplicate.reason).toBe("idempotency_in_progress");
  const conflict = await repository.beginAnalysisAdmission({
    ...request("same"),
    requestHash: "changed",
  });
  expect(conflict.kind === "rejected" && conflict.reason).toBe("idempotency_conflict");
});

async function finish(
  key: string,
  leaseId: string,
  responseBody: unknown = { runId: "run-1" },
  responseStatus = 202,
) {
  await repo().finishAnalysisAdmission({
    userId: "user-1",
    endpoint: "/analyze",
    idempotencyKey: key,
    leaseId,
    responseBody,
    responseStatus,
    idempotencyTtlSeconds: 600,
  });
}

test.each([202, 503])(
  "finishing releases capacity and replays the original %s response exactly once",
  async (status) => {
    const admission = await repo().beginAnalysisAdmission(request("reply"));
    if (admission.kind !== "admitted") throw new Error("Expected admission");
    const response = { runId: "run-1", nested: { status } };
    await Promise.all(
      Array.from({ length: 8 }, () => finish("reply", admission.leaseId, response, status)),
    );
    await finish("reply", admission.leaseId, { overwritten: true }, 200);
    expect(await repo().beginAnalysisAdmission(request("reply"))).toEqual({
      kind: "replay",
      responseBody: response,
      responseStatus: status,
    });
    expect((await repo().beginAnalysisAdmission(request("next"))).kind).toBe("admitted");
    expect(
      await runtime.db
        .prepare("SELECT request_count FROM analysis_daily_quotas")
        .first("request_count"),
    ).toBe(2);
  },
);

test("an expired worker cannot overwrite a reclaimed idempotency reply", async () => {
  const old = await repo().beginAnalysisAdmission(request("retry"));
  if (old.kind !== "admitted") throw new Error("Expected admission");
  now += 61_000;
  const retry = await repo().beginAnalysisAdmission(request("retry"));
  if (retry.kind !== "admitted") throw new Error("Expected retry admission");
  await finish("retry", old.leaseId, { old: true });
  expect((await repo().beginAnalysisAdmission(request("retry"))).kind).toBe("rejected");
  await finish("retry", retry.leaseId, { current: true });
  expect(await repo().beginAnalysisAdmission(request("retry"))).toEqual({
    kind: "replay",
    responseBody: { current: true },
    responseStatus: 202,
  });
});

test.each([
  ["userRateLimit", "user_rate_limit"],
  ["ipRateLimit", "ip_rate_limit"],
  ["dailyQuota", "daily_quota"],
] as const)(
  "%s charges only admissions and resets at its code-computed boundary",
  async (limit, reason) => {
    now = Date.parse("2026-10-12T23:59:30Z");
    const firstRequest = { ...request("first"), limits: { ...limits, [limit]: 1 } };
    const admitted = await repo().beginAnalysisAdmission(firstRequest);
    if (admitted.kind !== "admitted") throw new Error("Expected admission");
    await finish("first", admitted.leaseId);
    const rejected = await repo().beginAnalysisAdmission({
      ...firstRequest,
      idempotencyKey: "second",
    });
    expect(rejected.kind === "rejected" && rejected.reason).toBe(reason);
    expect(rejected.kind === "rejected" && rejected.retryAt).toBe(
      limit === "dailyQuota" ? "2026-10-13T00:00:00.000Z" : "2026-10-13T00:00:30.000Z",
    );
    expect(
      await runtime.db.prepare("SELECT count(*) FROM analysis_idempotency_keys").first("count(*)"),
    ).toBe(1);
    now += limit === "dailyQuota" ? 30_000 : 60_000;
    expect(
      (await repo().beginAnalysisAdmission({ ...firstRequest, idempotencyKey: "second" })).kind,
    ).toBe("admitted");
  },
);

test("IP capacity is shared across users while user capacity is isolated", async () => {
  await seedUser(runtime.db, "user-2");
  const shared = { ...limits, ipConcurrencyLimit: 1 };
  const first = await repo().beginAnalysisAdmission({ ...request("first"), limits: shared });
  expect(first.kind).toBe("admitted");
  const second = await repo().beginAnalysisAdmission({
    ...request("second"),
    userId: "user-2",
    limits: shared,
  });
  expect(second.kind === "rejected" && second.reason).toBe("ip_concurrency_limit");
  expect(
    (
      await repo().beginAnalysisAdmission({
        ...request("other-ip"),
        userId: "user-2",
        ipHash: "ip-2",
        limits: shared,
      })
    ).kind,
  ).toBe("admitted");
});

test("force cooldown is scoped by user and input and survives lease release", async () => {
  const forced = { ...request("forced"), forceReanalysis: true };
  const first = await repo().beginAnalysisAdmission(forced);
  if (first.kind !== "admitted") throw new Error("Expected admission");
  await finish("forced", first.leaseId);
  const cooldown = await repo().beginAnalysisAdmission({ ...forced, idempotencyKey: "again" });
  expect(cooldown.kind === "rejected" && cooldown.reason).toBe("force_reanalysis_cooldown");
  expect(cooldown.kind === "rejected" && cooldown.retryAt).toBe("2026-10-12T12:01:00.000Z");
  const other = await repo().beginAnalysisAdmission({
    ...forced,
    idempotencyKey: "different",
    forceInputHash: "different",
  });
  if (other.kind !== "admitted") throw new Error("Expected different-input admission");
  await finish("different", other.leaseId);
  now += 60_000;
  expect((await repo().beginAnalysisAdmission({ ...forced, idempotencyKey: "again" })).kind).toBe(
    "admitted",
  );
});

test("expired replies can be replaced and abandoned leases stop consuming capacity", async () => {
  const first = await repo().beginAnalysisAdmission(request("expiry"));
  if (first.kind !== "admitted") throw new Error("Expected admission");
  await finish("expiry", first.leaseId);
  now += 600_000;
  const changed = await repo().beginAnalysisAdmission({
    ...request("expiry"),
    requestHash: "changed",
  });
  expect(changed.kind).toBe("admitted");
  now += 60_000;
  expect((await repo().beginAnalysisAdmission(request("abandoned-capacity"))).kind).toBe(
    "admitted",
  );
});

test("a failed guarded admission batch rolls back its claim, counters and lease", async () => {
  await runtime.db.exec(
    "CREATE TRIGGER reject_admission BEFORE INSERT ON analysis_daily_quotas BEGIN SELECT RAISE(ABORT, 'injected admission failure'); END",
  );
  await expect(repo().beginAnalysisAdmission(request("rollback"))).rejects.toThrow();
  for (const table of [
    "analysis_idempotency_keys",
    "analysis_leases",
    "analysis_rate_limits",
    "analysis_daily_quotas",
  ])
    expect(await runtime.db.prepare(`SELECT count(*) FROM ${table}`).first("count(*)")).toBe(0);
  await runtime.db.exec("DROP TRIGGER reject_admission");
  expect((await repo().beginAnalysisAdmission(request("rollback"))).kind).toBe("admitted");
});

test("large idempotent responses replay from R2 and finish is scoped to its lease owner", async () => {
  const admission = await repo().beginAnalysisAdmission(request("large-response"));
  if (admission.kind !== "admitted") throw new Error("Expected admission");
  const input = {
    userId: "user-2",
    endpoint: "/analyze",
    idempotencyKey: "large-response",
    leaseId: admission.leaseId,
    responseBody: {},
    responseStatus: 200,
    idempotencyTtlSeconds: 600,
  };
  await repo().finishAnalysisAdmission(input);
  expect(
    await runtime.db
      .prepare("SELECT released_at FROM analysis_leases WHERE id=?")
      .bind(admission.leaseId)
      .first("released_at"),
  ).toBeNull();
  const response = { body: "x".repeat(1_600_000) };
  await finish("large-response", admission.leaseId, response);
  expect(
    await runtime.db
      .prepare("SELECT response_body FROM analysis_idempotency_keys")
      .first("response_body"),
  ).toBeNull();
  expect(await repo().beginAnalysisAdmission(request("large-response"))).toEqual({
    kind: "replay",
    responseBody: response,
    responseStatus: 202,
  });
});

test("failure in admission completion rolls back both reply and lease release", async () => {
  const admission = await repo().beginAnalysisAdmission(request("finish-rollback"));
  if (admission.kind !== "admitted") throw new Error("Expected admission");
  await runtime.db.exec(
    "CREATE TRIGGER reject_release BEFORE UPDATE ON analysis_leases BEGIN SELECT RAISE(ABORT, 'injected release failure'); END",
  );
  await expect(finish("finish-rollback", admission.leaseId)).rejects.toThrow();
  expect(
    await runtime.db
      .prepare("SELECT request_status FROM analysis_idempotency_keys")
      .first("request_status"),
  ).toBe("in_progress");
  expect(
    await runtime.db.prepare("SELECT released_at FROM analysis_leases").first("released_at"),
  ).toBeNull();
  await runtime.db.exec("DROP TRIGGER reject_release");
  await finish("finish-rollback", admission.leaseId);
  expect((await repo().beginAnalysisAdmission(request("finish-rollback"))).kind).toBe("replay");
});

const runs = () =>
  createD1AnalysisRepository({ database: runtime.db, bucket: runtime.bucket, now: () => now });
const context = (runId: string) => ({
  ...structuredClone(runContextExample),
  runId,
  tenantId: "user:user-1",
  ownerUserId: "user-1",
  visibility: "private" as const,
});
const scope = { tenantId: "user:user-1", ownerUserId: "user-1", visibility: "private" as const };
async function accepted(key: string) {
  const admission = await repo().beginAnalysisAdmission(request(key));
  if (admission.kind !== "admitted") throw new Error("Expected admission");
  const ctx = context(crypto.randomUUID());
  const launchAdmission = { endpoint: "/analyze", idempotencyKey: key, leaseId: admission.leaseId };
  await runs().createRun({ context: ctx, launchAdmission });
  expect(
    await runtime.db
      .prepare("SELECT request_status FROM analysis_idempotency_keys WHERE lease_id=?")
      .bind(admission.leaseId)
      .first("request_status"),
  ).toBe("accepted");
  return { admission, context: ctx, launchAdmission, identity: { scope, runId: ctx.runId } };
}

test("key expiry never replaces or purges a still-held unbound claim", async () => {
  const input = { ...request("short-key"), limits: { ...limits, idempotencyTtlSeconds: 1 } };
  const admission = await repo().beginAnalysisAdmission(input);
  if (admission.kind !== "admitted") throw new Error("Expected admission");
  now += 2_000;
  expect(await repo().beginAnalysisAdmission(input)).toMatchObject({
    kind: "rejected",
    reason: "idempotency_in_progress",
  });
  expect(await repo().beginAnalysisAdmission({ ...input, requestHash: "changed" })).toMatchObject({
    kind: "rejected",
    reason: "idempotency_conflict",
  });
  await createD1MaintenanceRepository({ database: runtime.db, now: () => now }).purgeExpired({
    rateWindowSeconds: 60,
  });
  expect(
    await runtime.db.prepare("SELECT lease_id FROM analysis_idempotency_keys").first("lease_id"),
  ).toBe(admission.leaseId);
});

test("accepted runs retain request identity and both capacity slots after lease and key expiry", async () => {
  const { context: ctx, identity, admission } = await accepted("long-run");
  now += 601_000;
  const maintenance = createD1MaintenanceRepository({ database: runtime.db, now: () => now });
  expect(await maintenance.purgeExpired({ rateWindowSeconds: 60 })).toMatchObject({
    leasesPurged: 0,
    idempotencyKeysPurged: 0,
  });
  const duplicate = await repo().beginAnalysisAdmission({
    ...request("long-run"),
    ipHash: "different-ip",
  });
  expect(duplicate).toMatchObject({
    kind: "replay",
    responseStatus: 202,
    responseBody: { runId: ctx.runId },
  });
  expect(
    await repo().beginAnalysisAdmission({ ...request("long-run"), requestHash: "changed" }),
  ).toMatchObject({ kind: "rejected", reason: "idempotency_conflict" });
  expect(await repo().beginAnalysisAdmission(request("blocked-user"))).toMatchObject({
    kind: "rejected",
    reason: "user_concurrency_limit",
  });
  await seedUser(runtime.db, "user-2");
  expect(
    await repo().beginAnalysisAdmission({
      ...request("blocked-ip"),
      userId: "user-2",
      limits: { ...limits, ipConcurrencyLimit: 1 },
    }),
  ).toMatchObject({ kind: "rejected", reason: "ip_concurrency_limit" });
  expect(
    await runtime.db
      .prepare("SELECT request_count FROM analysis_daily_quotas WHERE user_id='user-1'")
      .first("request_count"),
  ).toBe(1);
  const attempt = await runs().beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  expect(
    await runs().reserveRunUsage({
      ...identity,
      fencingToken: attempt.fencingToken,
      estimatedCostUsd: 0.01,
    }),
  ).toBe(true);
  await finish("long-run", admission.leaseId);
  expect(
    await runtime.db
      .prepare("SELECT released_at FROM analysis_leases WHERE id=?")
      .bind(admission.leaseId)
      .first("released_at"),
  ).toBeNull();
  await runs().failRun({ ...identity, fencingToken: attempt.fencingToken, error: "Stopped" });
  await finish("long-run", admission.leaseId, { runId: ctx.runId, status: "failed" }, 503);
  expect(await repo().beginAnalysisAdmission(request("long-run"))).toMatchObject({
    kind: "replay",
    responseStatus: 503,
    responseBody: { runId: ctx.runId, status: "failed" },
  });
  expect((await repo().beginAnalysisAdmission(request("capacity-after-settlement"))).kind).toBe(
    "admitted",
  );
});

test("a reclaimed pre-launch worker cannot persist a second run", async () => {
  const admission = await repo().beginAnalysisAdmission(request("reclaim-before-run"));
  if (admission.kind !== "admitted") throw new Error("Expected admission");
  now += 61_000;
  expect((await repo().beginAnalysisAdmission(request("reclaim-before-run"))).kind).toBe(
    "admitted",
  );
  const ctx = context("stale-run");
  await expect(
    runs().createRun({
      context: ctx,
      launchAdmission: {
        endpoint: "/analyze",
        idempotencyKey: "reclaim-before-run",
        leaseId: admission.leaseId,
      },
    }),
  ).rejects.toThrow();
  expect(await runs().getRunContext({ scope, runId: ctx.runId })).toBeNull();
});

test("run persistence and lease binding roll back together", async () => {
  const admission = await repo().beginAnalysisAdmission(request("binding-rollback"));
  if (admission.kind !== "admitted") throw new Error("Expected admission");
  await runtime.db.exec(
    "CREATE TRIGGER reject_binding BEFORE UPDATE OF run_id ON analysis_leases BEGIN SELECT RAISE(ABORT, 'binding failure'); END",
  );
  await expect(
    runs().createRun({
      context: context("unbound-run"),
      launchAdmission: {
        endpoint: "/analyze",
        idempotencyKey: "binding-rollback",
        leaseId: admission.leaseId,
      },
    }),
  ).rejects.toThrow();
  expect(await runs().getRunContext({ scope, runId: "unbound-run" })).toBeNull();
});

test("released ownership blocks attempts and physical request reservations", async () => {
  const { identity, admission } = await accepted("revoked");
  const attempt = await runs().beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  await runtime.db
    .prepare("UPDATE analysis_leases SET released_at=? WHERE id=?")
    .bind(now, admission.leaseId)
    .run();
  expect(
    await runs().reserveRunUsage({
      ...identity,
      fencingToken: attempt.fencingToken,
      estimatedCostUsd: 0.01,
    }),
  ).toBe(false);
  await expect(
    runs().beginAttempt({
      ...identity,
      stage: "normalize_input",
      expectedVersion: attempt.version,
    }),
  ).rejects.toThrow();
});

test.each(["inline", "metadata"])(
  "the migration binds existing %s run admissions before expiry cleanup",
  async (storage) => {
    const { context: ctx, admission, launchAdmission } = await accepted("migration-bound");
    if (storage === "inline")
      await runtime.db
        .prepare(
          "UPDATE core_runs SET launch_admission=NULL,launch_status='not_required',input_json=? WHERE run_id=?",
        )
        .bind(JSON.stringify({ admission: launchAdmission }), ctx.runId)
        .run();
    await runtime.db
      .prepare("UPDATE analysis_idempotency_keys SET request_status='in_progress'")
      .run();
    await runtime.db.prepare("ALTER TABLE analysis_leases DROP COLUMN run_id").run();
    const migration = await readFile(
      new URL("../../migrations/0007_admission_run_ownership.sql", import.meta.url),
      "utf8",
    );
    await runtime.db.batch(
      migration
        .split("--> statement-breakpoint")
        .filter((sql) => sql.trim())
        .map((sql) => runtime.db.prepare(sql)),
    );
    expect(
      await runtime.db
        .prepare("SELECT run_id FROM analysis_leases WHERE id=?")
        .bind(admission.leaseId)
        .first("run_id"),
    ).toBe(ctx.runId);
  },
);
