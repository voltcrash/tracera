import assert from "node:assert/strict";
import { describe, test } from "vite-plus/test";
import {
  analysisExamples,
  type StageResult,
  type EvidenceAssessment,
} from "@repo/contracts/analysis";
import { acceptStoredSnapshots, createRunAnalysis } from "../src/analysis/index.js";
import {
  assessmentResponse,
  createScriptedEvidenceEnvironment,
  evidenceSnapshot,
} from "../scripts/support/scripted-evidence.js";
import { createAssessEvidence } from "../src/analysis/evidence/index.js";

for (const scenario of ["later batch", "initial copies"] as const) {
  test(`the pipeline reclassifies ${scenario} before checking sufficiency`, async () => {
    const example = analysisExamples.complete;
    const primary = example.snapshots[0]!;
    const claim = example.claims[0]!;
    const snapshots =
      scenario === "later batch"
        ? [
            evidenceSnapshot("first_batch", claim.text, { url: "https://records.example/one" }),
            evidenceSnapshot("second_batch", `${claim.text} Official record.`, {
              url: "https://records.example/two",
            }),
          ]
        : [
            evidenceSnapshot("z_primary", claim.text, { url: "https://original.example/record" }),
            evidenceSnapshot("a_copy", claim.text, { url: "https://copy.example/record" }),
            evidenceSnapshot("fresh_record", `${claim.text} Official record.`, {
              url: "https://fresh.example/record",
            }),
          ];
    const { environment } = createScriptedEvidenceEnvironment(({ claim, snapshotId, passage }) =>
      assessmentResponse(claim, snapshotId, passage, {
        directness: ["first_batch", "a_copy"].includes(snapshotId) ? "secondary" : "primary",
      }),
    );
    environment.context.budget = {
      ...environment.context.budget,
      maxCostUsd: null,
      maxTargetedRetrievalRounds: 2,
    };
    const result = <Data>(data: Data): StageResult<Data> => ({
      status: "complete",
      data,
      issues: [],
      metrics: { ...example.stageOutcomes[0]!.metrics, externalRequests: 0, costUsd: 0 },
    });
    let observed: EvidenceAssessment[] = [];
    const retrievalRounds: number[] = [];
    const reachedProvenance = new Error("Observed accumulated evidence");
    const run = createRunAnalysis({
      stages: {
        normalizeInput: () => async () =>
          result({ snapshots: [primary], primarySnapshotId: primary.id }),
        extractClaims: () => async () =>
          result({ claims: [claim], coverage: example.inputCoverage }),
        retrieveEvidence:
          () =>
          async ({ round }) => {
            retrievalRounds.push(round);
            const acquired =
              scenario === "later batch"
                ? [snapshots[Math.min(round, 1)]!]
                : round === 0
                  ? snapshots.slice(0, 2)
                  : snapshots.slice(2);
            return result({
              snapshots: acquired,
              candidates: [],
              admittedSnapshotIds: acquired.map(({ id }) => id),
              budgetUsed: { externalRequests: 0, costUsd: 0 },
              stoppingReason: "plan_complete" as const,
            });
          },
        assessEvidence: () => createAssessEvidence(),
        traceOrigins:
          () =>
          async ({ assessments }) => {
            observed = assessments;
            throw reachedProvenance;
          },
      },
    });
    await assert.rejects(
      run({ input: { kind: "text", text: primary.normalizedText }, seed: 1 }, environment),
      (error) => error === reachedProvenance,
    );
    assert.deepEqual(retrievalRounds, [0, 1]);
    assert.equal(observed.length, snapshots.length);
    if (scenario === "later batch") {
      assert.ok(observed.every(({ dependence }) => dependence === "same_publisher"));
    } else {
      assert.equal(
        observed.find(({ snapshotId }) => snapshotId === "fresh_record")?.dependence,
        "independent",
      );
    }
  });
}

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
