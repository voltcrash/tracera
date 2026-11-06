import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { runContextExample } from "@repo/contracts/analysis";
import { createD1AnalysisRepository } from "../../src/repository.js";
import { createTestRuntime, seedUser } from "./runtime.js";
import { createD1AdmissionRepository } from "../../src/admission.js";
import { readFile } from "node:fs/promises";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
beforeAll(async () => {
  runtime = await createTestRuntime();
  await seedUser(runtime.db, "owner");
});
afterAll(async () => {
  await runtime?.dispose();
});
const scope = { tenantId: "launch", ownerUserId: "owner", visibility: "private" as const };

async function admit(runId: string) {
  const result = await createD1AdmissionRepository({ database: runtime.db }).beginAnalysisAdmission(
    {
      userId: "owner",
      ipHash: "launch",
      endpoint: "startAnalysis",
      idempotencyKey: runId,
      requestHash: runId,
      forceInputHash: runId,
      forceReanalysis: false,
      limits: {
        userRateLimit: 20,
        ipRateLimit: 20,
        rateWindowSeconds: 60,
        userConcurrencyLimit: 20,
        ipConcurrencyLimit: 20,
        dailyQuota: 20,
        forceReanalysisCooldownSeconds: 60,
        leaseSeconds: 60,
        idempotencyTtlSeconds: 600,
      },
    },
  );
  if (result.kind !== "admitted") throw new Error("Expected admission");
  return { endpoint: "startAnalysis", idempotencyKey: runId, leaseId: result.leaseId };
}

test("launch intent is durable, scoped, and never regresses after confirmation", async () => {
  const runs = createD1AnalysisRepository({ database: runtime.db });
  const context = { ...structuredClone(runContextExample), ...scope, runId: crypto.randomUUID() };
  await runs.createRun({
    context,
    launchAdmission: await admit(context.runId),
  });
  const identity = { scope, runId: context.runId };
  const status = () =>
    runtime.db
      .prepare("SELECT launch_status FROM core_runs WHERE run_id=?")
      .bind(context.runId)
      .first("launch_status");
  expect(await status()).toBe("pending");
  await runs.recordWorkflowLaunch({
    ...identity,
    scope: { ...scope, ownerUserId: "other" },
    status: "created",
  });
  expect(await status()).toBe("pending");
  await runs.recordWorkflowLaunch({ ...identity, status: "unknown" });
  expect(await status()).toBe("unknown");
  await runs.recordWorkflowLaunch({ ...identity, status: "created" });
  await runs.recordWorkflowLaunch({ ...identity, status: "unknown" });
  expect(await status()).toBe("created");
  const attempt = await runs.beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  expect(attempt.attempt).toBe(1);
  await expect(runs.createRun({ context })).rejects.toThrow("immutable input");
});

test("an executing Workflow confirms launch even if its create response was lost", async () => {
  const runs = createD1AnalysisRepository({ database: runtime.db });
  const context = { ...structuredClone(runContextExample), ...scope, runId: crypto.randomUUID() };
  await runs.createRun({
    context,
    launchAdmission: await admit(context.runId),
  });
  await runs.beginAttempt({
    scope,
    runId: context.runId,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  expect(
    await runtime.db
      .prepare("SELECT launch_status FROM core_runs WHERE run_id=?")
      .bind(context.runId)
      .first("launch_status"),
  ).toBe("created");
});

test("the launch migration recovers queued legacy admission IDs without changing run status", async () => {
  const isolated = await createTestRuntime();
  try {
    const runs = createD1AnalysisRepository({ database: isolated.db, bucket: isolated.bucket });
    const admission = {
      endpoint: "startAnalysis",
      idempotencyKey: "legacy",
      leaseId: "legacy-lease",
    };
    for (const runId of ["inline", "offloaded"]) {
      await runs.createRun({
        context: { ...structuredClone(runContextExample), ...scope, runId },
        payload: { admission },
        offloadInput: runId === "offloaded",
      });
    }
    for (const column of ["launch_status", "launch_attempted_at", "launch_admission"])
      await isolated.db.prepare(`ALTER TABLE core_runs DROP COLUMN ${column}`).run();
    const migration = await readFile(
      new URL("../../migrations/0006_workflow_launch.sql", import.meta.url),
      "utf8",
    );
    await isolated.db.batch(
      migration
        .split("--> statement-breakpoint")
        .filter((sql) => sql.trim())
        .map((sql) => isolated.db.prepare(sql)),
    );
    const inline = await isolated.db
      .prepare("SELECT status,launch_status,launch_admission FROM core_runs WHERE run_id='inline'")
      .first<{ status: string; launch_status: string; launch_admission: string }>();
    expect(inline).toMatchObject({ status: "queued", launch_status: "unknown" });
    expect(JSON.parse(inline!.launch_admission)).toEqual(admission);
    expect(
      await isolated.db
        .prepare(
          "SELECT status,launch_status,launch_admission FROM core_runs WHERE run_id='offloaded'",
        )
        .first(),
    ).toEqual({ status: "queued", launch_status: "unknown", launch_admission: null });
  } finally {
    await isolated.dispose();
  }
});
