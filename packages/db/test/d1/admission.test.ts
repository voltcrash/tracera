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
