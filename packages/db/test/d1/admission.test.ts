import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { createD1AdmissionRepository } from "../../src/d1/admission.js";
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
