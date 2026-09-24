import assert from "node:assert/strict";
import { describe, test } from "vite-plus/test";
import { coreV2Examples } from "@repo/contracts/core-v2";
import {
  acceptStoredSnapshots,
  decideReportReuse,
  hashValue,
  propositionScopeHash,
} from "../src/core/index.js";

describe("Core v2 stored artifacts", () => {
  test("stored snapshot IDs accept only identical immutable content", async () => {
    const [stored] = coreV2Examples.complete.snapshots;
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

  test("reuse requires exact content, scoped propositions, versions, visibility and freshness", () => {
    const example = coreV2Examples.complete;
    const identity = {
      contentHash: example.snapshots[0]!.contentHash,
      propositionScopeHash: propositionScopeHash(example.claims),
      versions: example.replayManifest.versions,
      visibility: example.visibility,
      asOfTime: example.asOfTime,
      maxAgeMs: 60_000,
    } as const;
    assert.equal(decideReportReuse(example, identity).reusable, true);
    assert.equal(decideReportReuse(null, identity).reason, "no_candidate");
    assert.equal(
      decideReportReuse(example, { ...identity, contentHash: hashValue("changed") }).reason,
      "content_changed",
    );
    assert.equal(
      decideReportReuse(example, { ...identity, propositionScopeHash: hashValue("similar story") })
        .reason,
      "proposition_scope_changed",
    );
    assert.equal(
      decideReportReuse(example, { ...identity, visibility: "public" }).reason,
      "visibility_changed",
    );
    assert.equal(
      decideReportReuse(example, {
        ...identity,
        versions: { ...identity.versions, calibration: "other-calibrator" },
      }).reason,
      "version_changed",
    );
    assert.equal(
      decideReportReuse(example, { ...identity, asOfTime: "2026-09-11T00:00:00.000Z" }).reason,
      "stale",
    );
    assert.equal(decideReportReuse(coreV2Examples.partial, identity).reason, "incomplete");
  });
});
