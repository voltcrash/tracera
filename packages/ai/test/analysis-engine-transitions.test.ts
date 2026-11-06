import { expect, test } from "vite-plus/test";
import {
  analysisExamples,
  stageNameSchema,
  type StageName,
  type StageResult,
} from "@repo/contracts/analysis";
import { createRunAnalysis, type RunAnalysisStageFactories } from "../src/analysis/run-analysis.js";
import { createFocusedPublication } from "../src/analysis/publication/index.js";
import { scoreReport } from "../src/analysis/scoring/index.js";
import { PENDING_CALIBRATION } from "../src/analysis/adjudication/adjudicate-claims.js";
import {
  evidenceSnapshot,
  createScriptedEvidenceEnvironment,
} from "../scripts/support/scripted-evidence.js";

const example = analysisExamples.complete;
const primary = example.snapshots.find(({ id }) => id === example.primarySnapshotId)!;
const stagesInOrder = stageNameSchema.options;

type Stop = "requests" | "cost" | "unknown_cost" | "deadline" | "owner_and_budget";

function pipeline(boundary: StageName, reason: Stop = "requests") {
  const { environment } = createScriptedEvidenceEnvironment(() => {
    throw new Error("Unexpected provider call");
  });
  const controller = new AbortController();
  environment.signal = controller.signal;
  environment.context.budget = {
    ...environment.context.budget,
    maxExternalRequests: 1,
    maxCostUsd: 1,
    maxElapsedMs: 100,
    maxTargetedRetrievalRounds: 0,
  };
  let elapsed = 0;
  environment.ports.clock.monotonicMs = () => elapsed;
  const calls: StageName[] = [];
  const finish = <Data>(stage: StageName, data: Data): StageResult<Data> => {
    calls.push(stage);
    const stopping = boundary === stage;
    if (stopping && reason === "deadline") elapsed = 100;
    if (stopping && reason === "owner_and_budget") controller.abort();
    return {
      status: "complete",
      data,
      issues: [],
      metrics: {
        ...example.stageOutcomes[0]!.metrics,
        externalRequests: stopping && ["requests", "owner_and_budget"].includes(reason) ? 2 : 0,
        costUsd:
          stopping && reason === "unknown_cost" ? null : stopping && reason === "cost" ? 2 : 0,
      },
    };
  };
  const factories: RunAnalysisStageFactories = {
    normalizeInput: () => async () =>
      finish("normalize_input", { snapshots: [primary], primarySnapshotId: primary.id }),
    extractClaims: () => async () =>
      finish("extract_claims", { claims: example.claims, coverage: example.inputCoverage }),
    retrieveEvidence: () => async () =>
      finish("retrieve_evidence", {
        candidates: example.candidates,
        snapshots: example.snapshots.filter(({ id }) => id !== primary.id),
        admittedSnapshotIds: example.assessments.map(({ snapshotId }) => snapshotId),
        budgetUsed: { externalRequests: 0, costUsd: 0 },
        stoppingReason: "plan_complete" as const,
      }),
    assessEvidence: () => async () =>
      finish("assess_evidence", { assessments: example.assessments, sufficiency: [] }),
    traceOrigins: () => async () =>
      finish("trace_origins", { graphs: example.provenance, newSnapshotIds: [] }),
    adjudicateClaims: () => async () =>
      finish("adjudicate_claims", {
        decisions: example.decisions.map((decision) => ({
          ...decision,
          publishedLabel: "unverified" as const,
          calibration: PENDING_CALIBRATION,
        })),
      }),
    publishFocusedDecisions: () => async (input, env) => {
      const published = await createFocusedPublication()(input, env);
      if (!published.data) throw new Error("Fixture publication failed");
      return finish("calibrate_decisions", published.data);
    },
    scoreReport: () => (input) => {
      const scored = scoreReport(input);
      if (!scored.data) throw new Error("Fixture scoring failed");
      return finish("score_report", scored.data);
    },
  };
  const run = () =>
    createRunAnalysis({ stages: factories })(
      { input: { kind: "text", text: primary.normalizedText }, seed: 1 },
      environment,
    );
  return { run, calls, factories, environment };
}

for (const [index, boundary] of stagesInOrder.entries()) {
  test(`${boundary} retains its artifacts before a shared-budget stop`, async () => {
    const fixture = pipeline(boundary);
    const result = await fixture.run();
    expect(result.status).toBe("partial");
    expect(fixture.calls).toEqual(stagesInOrder.slice(0, index + 1));
    const report = result.report!;
    expect(report.snapshots.map(({ id }) => id)).toContain(primary.id);
    if (index >= 1)
      expect(report.claims.map(({ id }) => id)).toEqual(example.claims.map(({ id }) => id));
    if (index >= 2) {
      expect(report.candidates).toEqual(example.candidates);
      expect(report.snapshots).toHaveLength(example.snapshots.length);
    }
    if (index >= 3)
      expect(report.assessments.map(({ id }) => id)).toEqual(
        example.assessments.map(({ id }) => id),
      );
    if (index >= 4) expect(report.provenance).toEqual(example.provenance);
    if (index >= 5) expect(report.decisions).toHaveLength(example.decisions.length);
    if (index === 5) {
      expect(report.decisions[0]!.publishedLabel).toBe("unverified");
      expect(report.decisions[0]!.focusedPublication).toMatchObject({
        status: "not_evaluated",
        gate: "not_evaluated",
      });
    }
    if (index >= 6) expect(report.decisions[0]!.publishedLabel).toBe("supported");
    if (index >= 7) expect(report.scorecard).not.toBeNull();
    expect(result.cost.externalRequests).toBe(2);
    expect(result.issues.some(({ code }) => code === "budget_exhausted")).toBe(true);
    expect(report.replayManifest.snapshotIds).toEqual(report.snapshots.map(({ id }) => id).sort());
    expect(report.replayManifest.assessmentIds).toEqual(
      report.assessments.map(({ id }) => id).sort(),
    );
  });
}

for (const reason of ["cost", "unknown_cost", "deadline", "owner_and_budget"] as const) {
  test(`normalization retains its snapshot when stopping for ${reason}`, async () => {
    const fixture = pipeline("normalize_input", reason);
    const result = await fixture.run();
    expect(result.status).toBe(reason === "owner_and_budget" ? "canceled" : "partial");
    expect(result.report!.primarySnapshotId).toBe(primary.id);
    expect(result.report!.snapshots).toEqual([primary]);
    expect(fixture.calls).toEqual(["normalize_input"]);
  });
}

const failureStops = ["none", "unknown_cost", "cost", "deadline", "owner"] as const;
test.each(failureStops)("reassessment failure during %s", async (reason) => {
  const fixture = pipeline("score_report");
  const fresh = evidenceSnapshot(
    "new_origin",
    "The original official register confirms the scoped record.",
  );
  const graph = structuredClone(example.provenance[0]!);
  graph.nodes.push({ ...graph.nodes[0]!, snapshotId: fresh.id, url: null });
  fixture.environment.ports.snapshots.getMany = async () => [fresh];
  fixture.factories.traceOrigins = () => async () => ({
    status: "complete",
    data: { graphs: [graph], newSnapshotIds: [fresh.id] },
    issues: [],
    metrics: { ...example.stageOutcomes[0]!.metrics, externalRequests: 0, costUsd: 0 },
  });
  const assess = fixture.factories.assessEvidence.bind(fixture.factories);
  let assessments = 0;
  fixture.factories.assessEvidence = (usage) => async (input, environment) => {
    assessments++;
    if (assessments === 1) return assess(usage)(input, environment);
    if (reason === "deadline") environment.ports.clock.monotonicMs = () => 100;
    if (reason === "owner") environment.signal = AbortSignal.abort();
    return {
      status: "failed",
      data: null,
      issues: [
        {
          code: "provider_outage",
          severity: "warning",
          message: "Reassessment failed",
          claimId: null,
          snapshotId: fresh.id,
          url: null,
        },
      ],
      metrics: {
        ...example.stageOutcomes[0]!.metrics,
        externalRequests: 1,
        costUsd: reason === "unknown_cost" || reason === "owner" ? null : reason === "cost" ? 2 : 0,
      },
    };
  };
  const result = await fixture.run();
  expect(result.status).toBe(reason === "owner" ? "canceled" : "failed");
  expect(result.report!.provenance).toEqual([graph]);
  expect(result.report!.snapshots.map(({ id }) => id)).toContain(fresh.id);
  expect(result.report!.assessments.map(({ id }) => id)).toEqual(
    example.assessments.map(({ id }) => id),
  );
  expect(result.report!.stageOutcomes.at(-1)).toMatchObject({
    stage: "trace_origins",
    status: "partial",
  });
  expect(result.cost.externalRequests).toBe(1);
  expect(assessments).toBe(2);
  expect(fixture.calls).not.toContain("adjudicate_claims");
});

test("cancellation after scoring suppresses the score while retaining earlier artifacts", async () => {
  const fixture = pipeline("score_report", "owner_and_budget");
  const result = await fixture.run();
  expect(result.status).toBe("canceled");
  expect(result.report!.scorecard).toBeNull();
  expect(result.report!.decisions[0]!.focusedPublication!.status).toBe("published");
  expect(result.report!.assessments).toHaveLength(1);
});
