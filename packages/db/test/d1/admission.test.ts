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
