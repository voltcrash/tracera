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
