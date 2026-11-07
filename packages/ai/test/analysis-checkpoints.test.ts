import { expect, test } from "vite-plus/test";
import { analysisExamples, stageNameSchema } from "@repo/contracts/analysis";
import { FOCUSED_PUBLICATION_POLICY } from "../src/analysis/publication/index.js";
import {
  readStageCheckpoint,
  writeStageCheckpoint,
  type StageCheckpoints,
} from "../src/analysis/checkpoints.js";
const example = analysisExamples.complete;
const metrics = example.stageOutcomes[0]!.metrics;
const result = <Data>(data: Data) => ({ status: "complete" as const, data, issues: [], metrics });
const cases: StageCheckpoints = {
  normalize_input: {
    result: result({ snapshots: example.snapshots, primarySnapshotId: example.primarySnapshotId! }),
    extra: null,
  },
  extract_claims: {
    result: result({ claims: example.claims, coverage: example.inputCoverage }),
    extra: null,
  },
  retrieve_evidence: {
    result: result({
      candidates: example.candidates,
      snapshots: example.snapshots,
      admittedSnapshotIds: [],
      budgetUsed: { externalRequests: 0, costUsd: 0 },
      stoppingReason: "plan_complete",
    }),
    extra: null,
  },
  assess_evidence: {
    result: result({ assessments: example.assessments, sufficiency: [] }),
    extra: { rounds: 0, targetedRetrieval: null },
  },
  trace_origins: {
    result: result({ graphs: example.provenance, newSnapshotIds: [] }),
    extra: null,
  },
  adjudicate_claims: { result: result({ decisions: example.decisions }), extra: [] },
  calibrate_decisions: {
    result: result({ policy: FOCUSED_PUBLICATION_POLICY, decisions: example.decisions }),
    extra: null,
  },
  score_report: {
    result: result({ scorecard: example.scorecard!, presentationFindings: [] }),
    extra: null,
  },
};

test.each(stageNameSchema.options)(
  "%s preserves valid v2 checkpoints and rejects malformed stage data and extras",
  (stage) => {
    const payload = writeStageCheckpoint(stage, cases[stage]);
    expect(readStageCheckpoint(stage, payload)).toMatchObject(cases[stage]);
    const badData = JSON.parse(payload);
    badData.result.data = {};
    expect(readStageCheckpoint(stage, JSON.stringify(badData))).toBeNull();
    const missingExtra = JSON.parse(payload);
    delete missingExtra.extra;
    expect(readStageCheckpoint(stage, JSON.stringify(missingExtra))).toBeNull();
    expect(readStageCheckpoint(stage, "not json")).toBeNull();
  },
);

test("assessment and adjudication retry state cannot be reused without its required fields", () => {
  const assessment = JSON.parse(writeStageCheckpoint("assess_evidence", cases.assess_evidence));
  assessment.extra.rounds = -1;
  expect(readStageCheckpoint("assess_evidence", JSON.stringify(assessment))).toBeNull();
  const adjudication = JSON.parse(
    writeStageCheckpoint("adjudicate_claims", cases.adjudicate_claims),
  );
  adjudication.extra = [{}];
  expect(readStageCheckpoint("adjudicate_claims", JSON.stringify(adjudication))).toBeNull();
});

test("unavailable results remain recorded outcomes without successful data", () => {
  const checkpoint = {
    result: {
      status: "unavailable" as const,
      data: null,
      metrics,
      issues: [
        {
          code: "capability_unavailable" as const,
          severity: "warning" as const,
          message: "Unavailable",
          claimId: null,
          snapshotId: null,
          url: null,
        },
      ],
    },
    extra: null,
  };
  expect(
    readStageCheckpoint("normalize_input", writeStageCheckpoint("normalize_input", checkpoint)),
  ).toMatchObject(checkpoint);
});

test("provenance checkpoints retain traversal outcomes and reject mismatched claim/document pairs", () => {
  const pair = example.assessments[0]!;
  const checkpoint: StageCheckpoints["trace_origins"] = {
    result: result({
      graphs: example.provenance,
      newSnapshotIds: [pair.snapshotId],
      assessmentResults: [
        {
          claimId: pair.claimId,
          snapshotId: pair.snapshotId,
          result: result({ assessments: [pair], sufficiency: [] }),
        },
      ],
    }),
    extra: { snapshots: example.snapshots, reassessment: null },
  };
  const payload = writeStageCheckpoint("trace_origins", checkpoint);
  expect(readStageCheckpoint("trace_origins", payload)).toMatchObject(checkpoint);
  const malformed = JSON.parse(payload);
  malformed.result.data.assessmentResults[0].snapshotId = "different_snapshot";
  expect(readStageCheckpoint("trace_origins", JSON.stringify(malformed))).toBeNull();
});
