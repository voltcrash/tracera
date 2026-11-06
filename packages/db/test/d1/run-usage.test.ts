import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { runContextExample } from "@repo/contracts/analysis";
import { createD1AnalysisRepository } from "../../src/repository.js";
import { createTestRuntime } from "./runtime.js";
import { readFile } from "node:fs/promises";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
beforeAll(async () => {
  runtime = await createTestRuntime();
});
afterAll(async () => {
  await runtime?.dispose();
});
const scope = { tenantId: "tenant", ownerUserId: "owner", visibility: "private" as const };

async function setup(maxTargetedRetrievalRounds = 2) {
  let now = Date.parse("2026-11-07T00:00:00Z");
  const repository = createD1AnalysisRepository({ database: runtime.db, now: () => now });
  const context = {
    ...structuredClone(runContextExample),
    ...scope,
    runId: crypto.randomUUID(),
    budget: {
      ...runContextExample.budget,
      maxExternalRequests: 3,
      maxTargetedRetrievalRounds,
      maxCostUsd: 0.04,
      maxElapsedMs: 10000,
    },
  };
  await repository.createRun({ context });
  const identity = { scope, runId: context.runId };
  const attempt = await repository.beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  return {
    repository,
    identity,
    attempt,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("concurrent physical requests cannot exceed either persisted run allowance", async () => {
  const { repository, identity, attempt } = await setup();
  const reserve = (estimatedCostUsd: number) =>
    repository.reserveRunUsage({
      ...identity,
      fencingToken: attempt.fencingToken,
      estimatedCostUsd,
    });
  const results = await Promise.all(Array.from({ length: 6 }, () => reserve(0.02)));
  expect(results.filter(Boolean)).toHaveLength(2);
  expect(await reserve(0)).toBe(true);
  expect(await reserve(0)).toBe(false);
  expect(await repository.getRunUsage(identity)).toEqual({
    externalRequests: 3,
    targetedRounds: 0,
    estimatedCostUsd: 0.04,
    startedAt: "2026-11-07T00:00:00.000Z",
  });
});

test("attempt retries retain prior charges and the first execution deadline", async () => {
  const { repository, identity, attempt, advance } = await setup();
  expect(
    await repository.reserveRunUsage({
      ...identity,
      fencingToken: attempt.fencingToken,
      estimatedCostUsd: 0.01,
    }),
  ).toBe(true);
  advance(1000);
  const progress = await repository.getRunProgress(identity);
  const retry = await repository.beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: progress!.version,
  });
  expect(
    await repository.reserveRunUsage({
      ...identity,
      fencingToken: attempt.fencingToken,
      estimatedCostUsd: 0,
    }),
  ).toBe(false);
  expect(
    await repository.reserveRunUsage({
      ...identity,
      fencingToken: retry.fencingToken,
      estimatedCostUsd: 0.01,
    }),
  ).toBe(true);
  advance(9000);
  expect(
    await repository.reserveRunUsage({
      ...identity,
      fencingToken: retry.fencingToken,
      estimatedCostUsd: 0,
    }),
  ).toBe(false);
  expect(await repository.getRunUsage(identity)).toMatchObject({
    externalRequests: 2,
    estimatedCostUsd: 0.02,
    startedAt: "2026-11-07T00:00:00.000Z",
  });
});

test("usage reservations reject another owner and requested cancellation", async () => {
  const { repository, identity, attempt } = await setup();
  expect(
    await repository.reserveRunUsage({
      ...identity,
      scope: { ...scope, ownerUserId: "other" },
      fencingToken: attempt.fencingToken,
      estimatedCostUsd: 0,
    }),
  ).toBe(false);
  expect(
    await repository.getRunUsage({ ...identity, scope: { ...scope, ownerUserId: "other" } }),
  ).toBeNull();
  await repository.requestCancellation({ ...identity, reason: "user_request" });
  expect(
    await repository.reserveRunUsage({
      ...identity,
      fencingToken: attempt.fencingToken,
      estimatedCostUsd: 0,
    }),
  ).toBe(false);
  expect(await repository.getRunUsage(identity)).toMatchObject({
    externalRequests: 0,
    estimatedCostUsd: 0,
  });
});

test("the usage migration does not grant a new allowance to previously running work", async () => {
  const isolated = await createTestRuntime();
  try {
    const repository = createD1AnalysisRepository({ database: isolated.db });
    for (const runId of ["queued", "running"]) {
      await repository.createRun({
        context: { ...structuredClone(runContextExample), ...scope, runId },
      });
    }
    const active = await repository.beginAttempt({
      scope,
      runId: "running",
      stage: "normalize_input",
      expectedVersion: 0,
    });
    for (const column of ["started_at", "usage_external_requests", "usage_cost_micros"]) {
      await isolated.db.prepare(`ALTER TABLE core_runs DROP COLUMN ${column}`).run();
    }
    const migration = await readFile(
      new URL("../../migrations/0005_mean_annihilus.sql", import.meta.url),
      "utf8",
    );
    await isolated.db.batch(
      migration
        .split("--> statement-breakpoint")
        .filter((sql) => sql.trim())
        .map((sql) => isolated.db.prepare(sql)),
    );
    expect(await repository.getRunUsage({ scope, runId: "queued" })).toEqual({
      externalRequests: 0,
      targetedRounds: 0,
      estimatedCostUsd: 0,
      startedAt: null,
    });
    expect(await repository.getRunUsage({ scope, runId: "running" })).toMatchObject({
      externalRequests: runContextExample.budget.maxExternalRequests,
    });
    expect(
      await repository.reserveRunUsage({
        scope,
        runId: "running",
        fencingToken: active.fencingToken,
        estimatedCostUsd: 0,
      }),
    ).toBe(false);
  } finally {
    await isolated.dispose();
  }
});

test("concurrent targeted rounds consume one shared allowance across attempts", async () => {
  const { repository, identity, attempt } = await setup();
  const reservations = await Promise.all(
    Array.from({ length: 6 }, () =>
      repository.reserveTargetedRound({ ...identity, fencingToken: attempt.fencingToken }),
    ),
  );
  expect(
    reservations.filter((round) => round !== null).sort((left, right) => left - right),
  ).toEqual([1, 2]);
  const progress = await repository.getRunProgress(identity);
  const retry = await repository.beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: progress!.version,
  });
  expect(
    await repository.reserveTargetedRound({ ...identity, fencingToken: retry.fencingToken }),
  ).toBeNull();
  expect(await repository.getRunUsage(identity)).toMatchObject({
    targetedRounds: 2,
    externalRequests: 0,
  });
});

test("a targeted reservation rejects stale ownership, cancellation, deadline and terminal runs", async () => {
  const { repository, identity, attempt, advance } = await setup();
  expect(
    await repository.reserveTargetedRound({
      ...identity,
      scope: { ...scope, ownerUserId: "other" },
      fencingToken: attempt.fencingToken,
    }),
  ).toBeNull();
  const retry = await repository.beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: attempt.version,
  });
  expect(
    await repository.reserveTargetedRound({ ...identity, fencingToken: attempt.fencingToken }),
  ).toBeNull();
  expect(
    await repository.reserveTargetedRound({ ...identity, fencingToken: retry.fencingToken }),
  ).toBe(1);
  advance(10000);
  expect(
    await repository.reserveTargetedRound({ ...identity, fencingToken: retry.fencingToken }),
  ).toBeNull();
  const canceled = await setup();
  await canceled.repository.requestCancellation({ ...canceled.identity, reason: "user_request" });
  expect(
    await canceled.repository.reserveTargetedRound({
      ...canceled.identity,
      fencingToken: canceled.attempt.fencingToken,
    }),
  ).toBeNull();
  const terminal = await setup();
  await terminal.repository.failRun({
    ...terminal.identity,
    fencingToken: terminal.attempt.fencingToken,
    error: "Stopped",
  });
  expect(
    await terminal.repository.reserveTargetedRound({
      ...terminal.identity,
      fencingToken: terminal.attempt.fencingToken,
    }),
  ).toBeNull();
  const disabled = await setup(0);
  expect(
    await disabled.repository.reserveTargetedRound({
      ...disabled.identity,
      fencingToken: disabled.attempt.fencingToken,
    }),
  ).toBeNull();
});

test("the targeted-round migration exhausts unknown prior usage without charging queued runs", async () => {
  const isolated = await createTestRuntime();
  try {
    const repository = createD1AnalysisRepository({ database: isolated.db });
    for (const runId of ["queued", "running"]) {
      await repository.createRun({
        context: { ...structuredClone(runContextExample), ...scope, runId },
      });
    }
    const attempt = await repository.beginAttempt({
      scope,
      runId: "running",
      stage: "normalize_input",
      expectedVersion: 0,
    });
    await isolated.db.prepare("ALTER TABLE core_runs DROP COLUMN usage_targeted_rounds").run();
    const migration = await readFile(
      new URL("../../migrations/0010_targeted_round_budget.sql", import.meta.url),
      "utf8",
    );
    await isolated.db.batch(
      migration
        .split("--> statement-breakpoint")
        .filter((sql) => sql.trim())
        .map((sql) => isolated.db.prepare(sql)),
    );
    expect(await repository.getRunUsage({ scope, runId: "queued" })).toMatchObject({
      targetedRounds: 0,
    });
    expect(await repository.getRunUsage({ scope, runId: "running" })).toMatchObject({
      targetedRounds: runContextExample.budget.maxTargetedRetrievalRounds,
    });
    expect(
      await repository.reserveTargetedRound({
        scope,
        runId: "running",
        fencingToken: attempt.fencingToken,
      }),
    ).toBeNull();
  } finally {
    await isolated.dispose();
  }
});
