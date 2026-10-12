import { createHash } from "node:crypto";
import { runContextExample, type DocumentSnapshot } from "@repo/contracts/analysis";
import { createD1AnalysisRepository, StaleWorkerError } from "@repo/db/d1";
import { createTestRuntime, seedUser } from "@repo/db/test-runtime";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
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
