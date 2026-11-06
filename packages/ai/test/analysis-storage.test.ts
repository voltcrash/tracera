import { createHash } from "node:crypto";
import {
  analysisExamples,
  runContextExample,
  type DocumentSnapshot,
} from "@repo/contracts/analysis";
import { createD1AnalysisRepository, StaleWorkerError } from "@repo/db";
import { createTestRuntime, seedUser } from "@repo/db/test-runtime";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createRunAnalysis } from "../src/analysis/run-analysis.js";
import { createScriptedEvidenceEnvironment } from "../scripts/support/scripted-evidence.js";
import { createRunStore, createSnapshotStore } from "../src/analysis/storage.js";

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const context = structuredClone(runContextExample);
let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
beforeAll(async () => {
  runtime = await createTestRuntime();
  await seedUser(runtime.db, context.ownerUserId);
});
afterAll(async () => {
  await runtime?.dispose();
});
const repository = () =>
  createD1AnalysisRepository({ database: runtime.db, bucket: runtime.bucket });

function snapshot(text: string): DocumentSnapshot {
  return {
    id: `snapshot-${hash(text).slice(-12)}`,
    contentHash: hash(text),
    rawContentHash: null,
    originalUrl: null,
    finalUrl: null,
    canonicalUrl: null,
    acquiredAt: context.asOfTime,
    mimeType: "text/plain",
    language: "en",
    role: "submitted_input",
    normalizedText: text,
    extractionStatus: "complete",
    extractionMethod: "plain_text",
    limits: {
      byteLimit: 5_000_000,
      characterLimit: 200_000,
      bytesRetained: new TextEncoder().encode(text).byteLength,
      charactersRetained: text.length,
      truncated: false,
    },
    locators: [],
    timestampAssertions: [],
    discoveryHints: [],
    blobLocator: { status: "unavailable", uri: null },
  };
}

test("snapshot storage validates bytes and retains the owner scope in real D1", async () => {
  const db = repository();
  const store = createSnapshotStore({ repository: db, context });
  const signal = new AbortController().signal;
  const valid = snapshot("A complete UTF-8 snapshot: café.");
  await store.put(valid, signal);
  expect(await store.get(valid.id, signal)).toEqual(valid);
  expect(await store.getMany([valid.id], signal)).toEqual([valid]);
  expect(
    await db.getSnapshot({
      scope: { ...context, ownerUserId: "another-owner" },
      snapshotId: valid.id,
    }),
  ).toBeNull();
  await expect(
    store.put({ ...valid, id: "forged", contentHash: hash("different") }, signal),
  ).rejects.toThrow(/contentHash does not match/);
  expect(await store.get("forged", signal)).toBeNull();
});

test("stored raw blobs require a hash that matches resolved bytes", async () => {
  const db = repository();
  const raw = new TextEncoder().encode("raw source bytes");
  const store = createSnapshotStore({
    repository: db,
    context,
    blobStore: {
      async put() {
        return { status: "stored", uri: "snapshot://raw" };
      },
      async read() {
        return raw;
      },
    },
  });
  const signal = new AbortController().signal;
  const valid = {
    ...snapshot("normalized source"),
    rawContentHash: hash("raw source bytes"),
    blobLocator: { status: "stored" as const, uri: "snapshot://raw" },
  };
  await store.put(valid, signal);
  expect(await store.get(valid.id, signal)).toEqual(valid);
  await expect(store.put({ ...valid, rawContentHash: hash("forged") }, signal)).rejects.toThrow(
    /rawContentHash does not match/,
  );
});

test("the run adapter preserves D1 fencing when a Workflow attempt is superseded", async () => {
  const db = repository();
  const created = await db.createRun({ context });
  const first = await db.beginAttempt({
    scope: context,
    runId: context.runId,
    stage: "normalize_input",
    expectedVersion: created.version,
  });
  const next = await db.beginAttempt({
    scope: context,
    runId: context.runId,
    stage: "normalize_input",
    expectedVersion: first.version,
  });
  const store = createRunStore({ repository: db, context });
  const request = {
    runId: context.runId,
    stage: "normalize_input" as const,
    checkpointHash: context.inputHash,
    payloadJson: "{}",
    signal: new AbortController().signal,
  };
  await expect(store.checkpoint({ ...request, ...first })).rejects.toThrow(StaleWorkerError);
  await store.checkpoint({ ...request, ...next });
  expect(await store.readCheckpoint(request)).toEqual({
    checkpointHash: context.inputHash,
    payloadJson: "{}",
  });
});

test("recovery recomputes checkpoint JSON corrupted in D1", async () => {
  const db = repository();
  const runContext = { ...structuredClone(context), runId: crypto.randomUUID() };
  const identity = { scope: runContext, runId: runContext.runId };
  await db.createRun({ context: runContext });
  const first = await db.beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  const { environment } = createScriptedEvidenceEnvironment(() => {
    throw new Error("Unexpected provider call");
  });
  environment.context = runContext;
  environment.ports.runs = createRunStore({ repository: db, context: runContext });
  let normalizations = 0;
  const reachedExtraction = new Error("Reached extraction");
  const stages = {
    normalizeInput: () => async () => {
      normalizations++;
      return {
        status: "complete" as const,
        data: {
          snapshots: analysisExamples.complete.snapshots,
          primarySnapshotId: analysisExamples.complete.primarySnapshotId!,
        },
        issues: [],
        metrics: analysisExamples.complete.stageOutcomes[0]!.metrics,
      };
    },
    extractClaims: () => async () => {
      throw reachedExtraction;
    },
  };
  const input = { input: { kind: "text" as const, text: "A claim." }, seed: 1 };
  await expect(createRunAnalysis({ ...first, stages })(input, environment)).rejects.toBe(
    reachedExtraction,
  );
  await runtime.db
    .prepare(
      "UPDATE core_stage_checkpoints SET payload_json='not json',payload_blob_uri=NULL WHERE run_id=? AND stage='normalize_input'",
    )
    .bind(runContext.runId)
    .run();
  const progress = await db.getRunProgress(identity);
  const retry = await db.beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: progress!.version,
  });
  await expect(createRunAnalysis({ ...retry, stages })(input, environment)).rejects.toBe(
    reachedExtraction,
  );
  expect(normalizations).toBe(2);
  const saved = await db.readCheckpoint({ ...identity, stage: "normalize_input" });
  expect(JSON.parse(saved!.payloadJson)).toMatchObject({
    version: 2,
    result: { data: { primarySnapshotId: analysisExamples.complete.primarySnapshotId } },
  });
});
