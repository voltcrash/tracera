import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { createD1SpendRepository } from "../../src/d1/spend.js";
import { createTestRuntime } from "./runtime.js";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
let now: number;
beforeEach(async () => {
  runtime = await createTestRuntime();
  now = Date.parse("2026-10-12T23:59:30Z");
});
afterEach(async () => {
  await runtime?.dispose();
});
const repo = () => createD1SpendRepository({ database: runtime.db, now: () => now });
const input = { providerKey: "gemini", estimatedUsd: 0.1, dailyBudgetUsd: 1 };

test("concurrent reservations never exceed the daily integer budget", async () => {
  const repository = repo();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => repository.reserveProviderSpend(input)),
  );
  expect(results.filter((result) => result.allowed)).toHaveLength(10);
  const row = await runtime.db
    .prepare("SELECT reserved_micros,actual_micros FROM ai_provider_spend")
    .first();
  expect(row).toEqual({ reserved_micros: 1_000_000, actual_micros: 0 });
});

test("reservation retries and concurrent settlements charge exactly once", async () => {
  const repository = repo();
  const id = "stable-reservation";
  const reservations = await Promise.all(
    Array.from({ length: 8 }, () =>
      repository.reserveProviderSpend({ ...input, reservationId: id }),
    ),
  );
  expect(reservations.every((result) => result.allowed)).toBe(true);
  await Promise.all(
    Array.from({ length: 8 }, () =>
      repository.settleProviderSpend({ reservationId: id, actualUsd: 0.05 }),
    ),
  );
  expect(
    await runtime.db.prepare("SELECT reserved_micros,actual_micros FROM ai_provider_spend").first(),
  ).toEqual({ reserved_micros: 0, actual_micros: 50_000 });
  await expect(
    repository.reserveProviderSpend({ ...input, reservationId: id, estimatedUsd: 0.2 }),
  ).rejects.toThrow(/immutable/);
});

test("platform and user-key spend counters are independent", async () => {
  const repository = repo();
  expect((await repository.reserveProviderSpend({ ...input, estimatedUsd: 1 })).allowed).toBe(true);
  expect((await repository.reserveProviderSpend(input)).allowed).toBe(false);
  expect((await repository.reserveProviderSpend({ ...input, keySource: "user" })).allowed).toBe(
    true,
  );
  expect((await repository.reserveProviderSpend({ ...input, providerKey: "openai" })).allowed).toBe(
    true,
  );
});

test("retry across UTC midnight retains the original period and does not recharge", async () => {
  const repository = repo();
  const original = await repository.reserveProviderSpend({ ...input, reservationId: "cross-day" });
  now = Date.parse("2026-10-13T00:01:00Z");
  expect(await repository.reserveProviderSpend({ ...input, reservationId: "cross-day" })).toEqual(
    original,
  );
  await repository.settleProviderSpend({ reservationId: "cross-day", actualUsd: NaN });
  expect(
    await runtime.db
      .prepare("SELECT period_start,reserved_micros,actual_micros FROM ai_provider_spend")
      .first(),
  ).toEqual({ period_start: "2026-10-12", reserved_micros: 0, actual_micros: 100_000 });
  expect((await repository.reserveProviderSpend(input)).allowed).toBe(true);
});

test("actual spend opens the circuit through UTC reset even after budget changes", async () => {
  await repo().reserveProviderSpend({ ...input, reservationId: "actual-spend" });
  await repo().settleProviderSpend({ reservationId: "actual-spend", actualUsd: 1.2 });
  expect(await repo().reserveProviderSpend({ ...input, dailyBudgetUsd: 100 })).toEqual({
    allowed: false,
    retryAt: "2026-10-13T00:00:00.000Z",
  });
  now = Date.parse("2026-10-13T00:00:00Z");
  expect((await repo().reserveProviderSpend(input)).allowed).toBe(true);
});

test("failed reservation and settlement batches never leave partial charges", async () => {
  await runtime.db.exec(
    "CREATE TRIGGER reject_charge BEFORE UPDATE OF reserved_micros ON ai_provider_spend BEGIN SELECT RAISE(ABORT, 'injected spend failure'); END",
  );
  await expect(
    repo().reserveProviderSpend({ ...input, reservationId: "rollback" }),
  ).rejects.toThrow();
  expect(
    await runtime.db.prepare("SELECT count(*) FROM ai_spend_reservations").first("count(*)"),
  ).toBe(0);
  expect(await runtime.db.prepare("SELECT count(*) FROM ai_provider_spend").first("count(*)")).toBe(
    0,
  );
  await runtime.db.exec("DROP TRIGGER reject_charge");
  await repo().reserveProviderSpend({ ...input, reservationId: "rollback" });
  await runtime.db.exec(
    "CREATE TRIGGER reject_settlement BEFORE UPDATE ON ai_spend_reservations BEGIN SELECT RAISE(ABORT, 'injected settlement failure'); END",
  );
  await expect(
    repo().settleProviderSpend({ reservationId: "rollback", actualUsd: 0.05 }),
  ).rejects.toThrow();
  expect(
    await runtime.db.prepare("SELECT reserved_micros,actual_micros FROM ai_provider_spend").first(),
  ).toEqual({ reserved_micros: 100_000, actual_micros: 0 });
  expect(
    await runtime.db.prepare("SELECT settled_at FROM ai_spend_reservations").first("settled_at"),
  ).toBeNull();
  await runtime.db.exec("DROP TRIGGER reject_settlement");
  await repo().settleProviderSpend({ reservationId: "rollback", actualUsd: 0.05 });
  expect(
    await runtime.db.prepare("SELECT reserved_micros,actual_micros FROM ai_provider_spend").first(),
  ).toEqual({ reserved_micros: 0, actual_micros: 50_000 });
});
