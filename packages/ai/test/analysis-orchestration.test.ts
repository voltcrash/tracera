import assert from "node:assert/strict";
import { describe, test } from "vite-plus/test";
import { analysisExamples } from "@repo/contracts/analysis";
import { acceptStoredSnapshots } from "../src/analysis/index.js";

describe("stored analysis artifacts", () => {
  test("stored snapshot IDs accept only identical immutable content", async () => {
    const [stored] = analysisExamples.complete.snapshots;
    const writes: string[] = [];
    const store = acceptStoredSnapshots({
      put: async (snapshot) => {
        writes.push(snapshot.id);
      },
      get: async (id) => (id === stored!.id ? stored! : null),
      getMany: async () => [],
    });
    const signal = new AbortController().signal;
    const repeated = { ...stored!, acquiredAt: "2026-09-12T00:00:00.000Z" };
    await store.put(repeated, signal);
    assert.deepEqual(writes, []);
    assert.equal(repeated.acquiredAt, stored!.acquiredAt);
    await assert.rejects(store.put({ ...stored!, language: "fr" }, signal), /different content/);
    await assert.rejects(
      store.put({ ...stored!, normalizedText: `${stored!.normalizedText} altered` }, signal),
      /different content/,
    );
  });
});
