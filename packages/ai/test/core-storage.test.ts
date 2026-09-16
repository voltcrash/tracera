import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runContextExample, type DocumentSnapshot } from "@repo/contracts/core-v2";
import {
  CoreStorageRepository,
  StaleWorkerError,
  type CorePool,
  type CoreQueryResult,
} from "@repo/db/core";
import { test } from "vite-plus/test";
import { createSnapshotStore } from "../src/core/storage.js";

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function snapshot(text: string): DocumentSnapshot {
  return {
    id: `snapshot-${hash(text).slice(-12)}`,
    contentHash: hash(text),
    rawContentHash: null,
    originalUrl: null,
    finalUrl: null,
    canonicalUrl: null,
    acquiredAt: runContextExample.asOfTime,
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

test("snapshot storage validates bytes before issuing a tenant-bound immutable insert", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    async query<Row = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ): Promise<CoreQueryResult<Row>> {
      calls.push({ text, values });
      return { rows: [{ snapshot_id: "stored" } as Row], rowCount: 1 };
    },
    async connect() {
      throw new Error("A transaction is not expected by this fixture.");
    },
  } satisfies CorePool;
  const repository = new CoreStorageRepository(pool);
  const store = createSnapshotStore({ repository, context: runContextExample });
  const valid = snapshot("A complete UTF-8 snapshot: café.");
  await store.put(valid, new AbortController().signal);

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.text ?? "", /ON CONFLICT .* DO NOTHING/);
  assert.deepEqual(calls[0]?.values.slice(1, 4), [
    runContextExample.tenantId,
    runContextExample.ownerUserId,
    runContextExample.visibility,
  ]);

  await assert.rejects(
    store.put(
      { ...valid, id: "forged", contentHash: hash("different") },
      new AbortController().signal,
    ),
    /contentHash does not match/,
  );
  assert.equal(calls.length, 1);
});

test("stored raw blobs require a hash that matches resolved bytes", async () => {
  const raw = new TextEncoder().encode("raw source bytes");
  const pool = {
    async query<Row = Record<string, unknown>>(): Promise<CoreQueryResult<Row>> {
      return { rows: [{ snapshot_id: "stored" } as Row], rowCount: 1 };
    },
    async connect() {
      throw new Error("A transaction is not expected by this fixture.");
    },
  } satisfies CorePool;
  const store = createSnapshotStore({
    repository: new CoreStorageRepository(pool),
    context: runContextExample,
    blobStore: {
      async put() {
        return { status: "stored", uri: "snapshot://raw" };
      },
      async read() {
        return raw;
      },
    },
  });
  const valid = {
    ...snapshot("normalized source"),
    rawContentHash: hash("raw source bytes"),
    blobLocator: { status: "stored" as const, uri: "snapshot://raw" },
  };
  await store.put(valid, new AbortController().signal);
  await assert.rejects(
    store.put({ ...valid, rawContentHash: hash("forged") }, new AbortController().signal),
    /rawContentHash does not match/,
  );
});

test("checkpoint writes fail closed when attempt and fencing validation changes no row", async () => {
  const pool = {
    async query<Row = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ): Promise<CoreQueryResult<Row>> {
      assert.match(text, /attempt = \$3 AND fencing_token = \$4/);
      assert.deepEqual(values.slice(4, 7), [
        runContextExample.tenantId,
        runContextExample.ownerUserId,
        runContextExample.visibility,
      ]);
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      throw new Error("A transaction is not expected by this fixture.");
    },
  } satisfies CorePool;
  const repository = new CoreStorageRepository(pool);
  await assert.rejects(
    repository.checkpoint({
      scope: {
        tenantId: runContextExample.tenantId,
        ownerUserId: runContextExample.ownerUserId,
        visibility: runContextExample.visibility,
      },
      runId: runContextExample.runId,
      stage: "normalize_input",
      attempt: 1,
      fencingToken: "expired-token",
      checkpointHash: runContextExample.inputHash,
      payloadJson: "{}",
    }),
    StaleWorkerError,
  );
});
