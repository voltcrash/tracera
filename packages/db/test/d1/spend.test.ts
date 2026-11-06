import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { createD1SpendRepository } from "../../src/spend.js";
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
  expect(results.filter((result) => result.kind === "reserved")).toHaveLength(10);
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
  expect(reservations.filter((result) => result.kind === "reserved")).toHaveLength(1);
  expect(
    reservations.filter((result) => result.kind === "existing" && result.state === "pending"),
  ).toHaveLength(7);
  await Promise.all(
    Array.from({ length: 8 }, () =>
      repository.settleProviderSpend({ reservationId: id, measuredUsd: 0.05 }),
    ),
  );
  expect(
    await runtime.db.prepare("SELECT reserved_micros,actual_micros FROM ai_provider_spend").first(),
  ).toEqual({ reserved_micros: 0, actual_micros: 50_000 });
  expect(await repository.reserveProviderSpend({ ...input, reservationId: id })).toMatchObject({
    kind: "existing",
    state: "settled",
  });
  await expect(
    repository.reserveProviderSpend({ ...input, reservationId: id, estimatedUsd: 0.2 }),
  ).rejects.toThrow(/immutable/);
});

test("platform and user-key spend counters are independent", async () => {
  const repository = repo();
  expect((await repository.reserveProviderSpend({ ...input, estimatedUsd: 1 })).kind).toBe(
    "reserved",
  );
  expect((await repository.reserveProviderSpend(input)).kind).toBe("rejected");
  expect((await repository.reserveProviderSpend({ ...input, keySource: "user" })).kind).toBe(
    "reserved",
  );
  expect((await repository.reserveProviderSpend({ ...input, providerKey: "openai" })).kind).toBe(
    "reserved",
  );
});

test("retry across UTC midnight retains the original period and does not recharge", async () => {
  const repository = repo();
  const original = await repository.reserveProviderSpend({ ...input, reservationId: "cross-day" });
  now = Date.parse("2026-10-13T00:01:00Z");
  expect(
    await repository.reserveProviderSpend({ ...input, reservationId: "cross-day" }),
  ).toMatchObject({
    kind: "existing",
    reservation: original.kind === "reserved" ? original.reservation : null,
    state: "pending",
  });
  await repository.settleProviderSpend({ reservationId: "cross-day" });
  expect(
    await runtime.db
      .prepare("SELECT period_start,reserved_micros,actual_micros FROM ai_provider_spend")
      .first(),
  ).toEqual({ period_start: "2026-10-12", reserved_micros: 0, actual_micros: 100_000 });
  expect((await repository.reserveProviderSpend(input)).kind).toBe("reserved");
});

test("actual spend opens the circuit through UTC reset even after budget changes", async () => {
  await repo().reserveProviderSpend({ ...input, reservationId: "actual-spend" });
  await repo().settleProviderSpend({ reservationId: "actual-spend", measuredUsd: 1.2 });
  expect(await repo().reserveProviderSpend({ ...input, dailyBudgetUsd: 100 })).toEqual({
    kind: "rejected",
    reason: "circuit_open",
    retryAt: "2026-10-13T00:00:00.000Z",
  });
  now = Date.parse("2026-10-13T00:00:00Z");
  expect((await repo().reserveProviderSpend(input)).kind).toBe("reserved");
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
    repo().settleProviderSpend({ reservationId: "rollback", measuredUsd: 0.05 }),
  ).rejects.toThrow();
  expect(
    await runtime.db.prepare("SELECT reserved_micros,actual_micros FROM ai_provider_spend").first(),
  ).toEqual({ reserved_micros: 100_000, actual_micros: 0 });
  expect(
    await runtime.db.prepare("SELECT settled_at FROM ai_spend_reservations").first("settled_at"),
  ).toBeNull();
  await runtime.db.exec("DROP TRIGGER reject_settlement");
  await repo().settleProviderSpend({ reservationId: "rollback", measuredUsd: 0.05 });
  expect(
    await runtime.db.prepare("SELECT reserved_micros,actual_micros FROM ai_provider_spend").first(),
  ).toEqual({ reserved_micros: 0, actual_micros: 50_000 });
});

test("a request that does not fit cannot latch out smaller requests", async () => {
  await repo().reserveProviderSpend({ ...input, estimatedUsd: 0.8 });
  await repo().reserveProviderSpend({ ...input, estimatedUsd: 0.3 });
  expect((await repo().reserveProviderSpend({ ...input, estimatedUsd: 0.1 })).kind).toBe(
    "reserved",
  );
});

test("settlement records estimates and measurements without relabeling either", async () => {
  await repo().reserveProviderSpend({ ...input, reservationId: "estimated" });
  await repo().reserveProviderSpend({ ...input, reservationId: "measured" });
  await repo().settleProviderSpend({ reservationId: "estimated" });
  await repo().settleProviderSpend({ reservationId: "measured", measuredUsd: 0.04 });
  expect(
    await runtime.db
      .prepare(
        "SELECT reserved_micros,actual_micros,estimated_settled_micros,measured_settled_micros FROM ai_provider_spend",
      )
      .first(),
  ).toEqual({
    reserved_micros: 0,
    actual_micros: 140_000,
    estimated_settled_micros: 100_000,
    measured_settled_micros: 40_000,
  });
  const rows = await runtime.db
    .prepare("SELECT id,settlement_basis FROM ai_spend_reservations ORDER BY id")
    .all();
  expect(rows.results).toEqual([
    { id: "estimated", settlement_basis: "estimated" },
    { id: "measured", settlement_basis: "measured" },
  ]);
});

test("invalid measurements preserve pending reservations and smaller settled charges release headroom", async () => {
  await repo().reserveProviderSpend({ ...input, reservationId: "lower-charge", estimatedUsd: 1 });
  expect((await repo().reserveProviderSpend(input)).kind).toBe("rejected");
  await expect(
    repo().settleProviderSpend({ reservationId: "lower-charge", measuredUsd: NaN }),
  ).rejects.toThrow(RangeError);
  expect(
    await runtime.db.prepare("SELECT settled_at FROM ai_spend_reservations").first("settled_at"),
  ).toBeNull();
  await repo().settleProviderSpend({ reservationId: "lower-charge", measuredUsd: 0.2 });
  expect((await repo().reserveProviderSpend(input)).kind).toBe("reserved");
  expect(
    await runtime.db.prepare("SELECT open_until FROM ai_provider_spend").first("open_until"),
  ).toBeNull();
});

test("fractional micro-dollar estimates round up and caps round down", async () => {
  expect(
    (
      await repo().reserveProviderSpend({
        ...input,
        estimatedUsd: 0.0000001,
        dailyBudgetUsd: 0.0000019,
      })
    ).kind,
  ).toBe("reserved");
  expect(
    (
      await repo().reserveProviderSpend({
        ...input,
        estimatedUsd: 0.0000001,
        dailyBudgetUsd: 0.0000019,
      })
    ).kind,
  ).toBe("rejected");
  expect(
    await runtime.db.prepare("SELECT reserved_micros,budget_micros FROM ai_provider_spend").first(),
  ).toEqual({ reserved_micros: 1, budget_micros: 1 });
});

test("the migration preserves old charges and circuits without inventing their settlement basis", async () => {
  await repo().reserveProviderSpend({ ...input, reservationId: "legacy" });
  await repo().settleProviderSpend({ reservationId: "legacy", measuredUsd: 1.2 });
  await repo().reserveProviderSpend({ ...input, dailyBudgetUsd: 100 });
  const before = await runtime.db
    .prepare("SELECT actual_micros,open_until FROM ai_provider_spend")
    .first();
  for (const column of ["estimated_settled_micros", "measured_settled_micros"])
    await runtime.db.prepare(`ALTER TABLE ai_provider_spend DROP COLUMN ${column}`).run();
  await runtime.db.prepare("ALTER TABLE ai_spend_reservations DROP COLUMN settlement_basis").run();
  const { readFile } = await import("node:fs/promises");
  const migration = await readFile(
    new URL("../../migrations/0009_spend_settlement_basis.sql", import.meta.url),
    "utf8",
  );
  await runtime.db.batch(
    migration
      .split("--> statement-breakpoint")
      .filter((sql) => sql.trim())
      .map((sql) => runtime.db.prepare(sql)),
  );
  expect(
    await runtime.db.prepare("SELECT actual_micros,open_until FROM ai_provider_spend").first(),
  ).toEqual(before);
  expect(
    await runtime.db
      .prepare("SELECT estimated_settled_micros,measured_settled_micros FROM ai_provider_spend")
      .first(),
  ).toEqual({ estimated_settled_micros: 0, measured_settled_micros: 0 });
  expect(
    await runtime.db
      .prepare("SELECT settlement_basis FROM ai_spend_reservations WHERE id='legacy'")
      .first("settlement_basis"),
  ).toBe("legacy_unknown");
});
