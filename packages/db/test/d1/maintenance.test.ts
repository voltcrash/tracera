import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import {
  createD1MaintenanceRepository,
  createD1AdmissionRepository,
  createD1SpendRepository,
} from "../../src/d1/index.js";
import { createTestRuntime, seedUser } from "./runtime.js";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
const NOW = Date.parse("2026-10-12T12:00:00Z");
beforeEach(async () => {
  runtime = await createTestRuntime();
});
afterEach(async () => {
  await runtime?.dispose();
});
const limits = {
  userRateLimit: 100,
  ipRateLimit: 100,
  rateWindowSeconds: 60,
  userConcurrencyLimit: 2,
  ipConcurrencyLimit: 2,
  dailyQuota: 100,
  forceReanalysisCooldownSeconds: 60,
  leaseSeconds: 60,
  idempotencyTtlSeconds: 60,
};

test("expiry cleanup purges stale controls and auth data while preserving active rows", async () => {
  for (const id of ["expired", "live", "released"]) {
    await seedUser(runtime.db, id);
    const now = id === "expired" ? NOW - 65_000 : NOW;
    const admission = createD1AdmissionRepository({ database: runtime.db, now: () => now });
    const result = await admission.beginAnalysisAdmission({
      userId: id,
      ipHash: id,
      endpoint: "start",
      idempotencyKey: id,
      requestHash: id,
      forceInputHash: id,
      forceReanalysis: false,
      limits,
    });
    if (result.kind !== "admitted") throw new Error("Synthetic admission failed.");
    if (id === "released")
      await admission.finishAnalysisAdmission({
        userId: id,
        endpoint: "start",
        idempotencyKey: id,
        leaseId: result.leaseId,
        responseBody: {},
        responseStatus: 200,
        idempotencyTtlSeconds: 60,
      });
  }
  for (const [id, expires] of [
    ["expired", NOW - 1],
    ["live", NOW + 1],
  ] as const) {
    await runtime.db
      .prepare(
        "INSERT INTO sessions(id,expires_at,token,created_at,updated_at,user_id) VALUES(?,?,?,?,?,?)",
      )
      .bind(id, expires, id, NOW, NOW, id)
      .run();
    await runtime.db
      .prepare(
        "INSERT INTO verifications(id,identifier,value,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(id, id, id, expires, NOW, NOW)
      .run();
  }
  const repository = createD1MaintenanceRepository({ database: runtime.db, now: () => NOW });
  const counts = await repository.purgeExpired({ rateWindowSeconds: 60 });
  expect(counts).toMatchObject({
    idempotencyKeysPurged: 1,
    leasesPurged: 2,
    rateWindowsPurged: 2,
    sessionsPurged: 1,
    verificationsPurged: 1,
  });
  expect(await runtime.db.prepare("SELECT id FROM analysis_leases").first("id")).toBeTruthy();
  expect(await runtime.db.prepare("SELECT id FROM sessions").first("id")).toBe("live");
  expect(await runtime.db.prepare("SELECT id FROM verifications").first("id")).toBe("live");
  expect(await repository.purgeExpired({ rateWindowSeconds: 60 })).toEqual({
    reservationsSettled: 0,
    idempotencyKeysPurged: 0,
    leasesPurged: 0,
    rateWindowsPurged: 0,
    sessionsPurged: 0,
    verificationsPurged: 0,
    reservationsPurged: 0,
  });
});

test("concurrent cleanup charges expired reservations once and preserves future reservations", async () => {
  const old = createD1SpendRepository({ database: runtime.db, now: () => NOW - 3_600_001 });
  await old.reserveProviderSpend({
    providerKey: "expired-provider",
    estimatedUsd: 1,
    dailyBudgetUsd: 1,
    reservationId: "expired-reservation",
  });
  const live = createD1SpendRepository({ database: runtime.db, now: () => NOW });
  await live.reserveProviderSpend({
    providerKey: "live-provider",
    estimatedUsd: 0.25,
    dailyBudgetUsd: 1,
    reservationId: "live-reservation",
  });
  const repository = createD1MaintenanceRepository({ database: runtime.db, now: () => NOW });
  const counts = await Promise.all([
    repository.purgeExpired({ rateWindowSeconds: 60 }),
    repository.purgeExpired({ rateWindowSeconds: 60 }),
  ]);
  expect(counts.reduce((total, item) => total + item.reservationsSettled, 0)).toBe(1);
  const spend = await runtime.db
    .prepare(
      "SELECT reserved_micros,actual_micros,open_until FROM ai_provider_spend WHERE provider_key='expired-provider'",
    )
    .first();
  expect(spend).toMatchObject({
    reserved_micros: 0,
    actual_micros: 1_000_000,
    open_until: Date.parse("2026-10-13T00:00:00Z"),
  });
  expect(await runtime.db.prepare("SELECT id FROM ai_spend_reservations").first("id")).toBe(
    "live-reservation",
  );
  expect(
    await runtime.db
      .prepare("SELECT reserved_micros FROM ai_provider_spend WHERE provider_key='live-provider'")
      .first("reserved_micros"),
  ).toBe(250_000);
});
