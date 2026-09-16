import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  decisionSchema,
  runContextExample,
  type EvidenceAssessment,
} from "@repo/contracts/core-v2";
import { createAdjudicateClaimsV2 } from "../src/core/adjudication/index.js";
import {
  CALIBRATION_FEATURE_NAMES,
  CALIBRATION_OBSERVATION_SET_VERSION,
  RELEASE_CALIBRATION_POLICY,
  checkCalibratorArtifact,
  createCalibrateDecisionsV2,
  fitCorrectnessCalibrator,
} from "../src/core/calibration/index.js";
import { contentHash, datasetHash, type EvaluationDataset } from "../evaluation/schemas.js";
import {
  ADJUDICATION_SCENARIOS,
  adjudicate,
  calibrate,
  contradictionEvidence,
  runAdjudicationScenario,
} from "../scripts/support/adjudication-scenarios.js";
import {
  adjudicationAssessment,
  adjudicationClaim,
  adjudicationSnapshot,
  challenge,
  createAdjudicationEnvironment,
  draft,
  syntheticCalibratorArtifact,
} from "../scripts/support/scripted-adjudication.js";

for (const scenario of ADJUDICATION_SCENARIOS) {
  test(`pass-condition fixture: ${scenario}`, async () => {
    await runAdjudicationScenario(scenario);
  });
}

test("needs-context claims abstain before any evidence or model is consulted", async () => {
  const claim = adjudicationClaim({
    checkability: "needs_context",
    unresolvedContext: ["'It' has no antecedent."],
  });
  const fixture = createAdjudicationEnvironment({ snapshots: [] });
  const result = await createAdjudicateClaimsV2()(
    { claims: [claim], assessments: [], graphs: [] },
    fixture.environment,
  );
  assert.deepEqual(result.data!.decisions[0]!.reasonCodes, [
    "ambiguous_claim_scope",
    "unresolved_context",
  ]);
  assert.equal(fixture.requests.length, 0);
});

test("a fabricated citation from the draft is rejected instead of dropped", async () => {
  const { snapshots, assessments } = contradictionEvidence();
  const { result, fixture } = await adjudicate(assessments, snapshots, {
    draft: () => draft("contradicted", { contradictingAssessmentIds: ["assessment_invented"] }),
  });
  const decision = result.data!.decisions[0]!;
  assert.equal(decision.diagnosticLabel, "unverified");
  assert.equal(decision.citationIntegrity, "invalid");
  assert.equal(fixture.challengeCalls, 0);
  assert.equal(result.status, "partial");
  assert.ok(result.issues.some(({ code }) => code === "citation_validation_failed"));
});

test("a purportedly validated assessment with shifted offsets blocks the claim before any model call", async () => {
  const { snapshots, assessments } = contradictionEvidence();
  const shifted: EvidenceAssessment = {
    ...assessments[0]!,
    excerpt: {
      ...assessments[0]!.excerpt,
      span: { start: 1, end: assessments[0]!.excerpt.span.end },
    },
  };
  const { result, fixture } = await adjudicate([shifted], snapshots, {
    draft: () => draft("contradicted", { contradictingAssessmentIds: [shifted.id] }),
  });
  assert.equal(result.data!.decisions[0]!.citationIntegrity, "invalid");
  assert.equal(fixture.requests.length, 0);
});

test("provenance evidence that was not reassessed prevents adjudicating stale assessments", async () => {
  const { snapshots, assessments } = contradictionEvidence();
  const fixture = createAdjudicationEnvironment({ snapshots });
  const graph = {
    claimId: adjudicationClaim().id,
    nodes: [
      {
        snapshotId: "newly_acquired",
        role: "report" as const,
        url: null,
        timestamps: [],
        claimPresentInContent: true,
      },
    ],
    edges: [],
    candidateRoots: [],
    searchLog: [],
    searchedDateRange: { earliest: null, latest: null, precision: null, timezone: null },
    hopsUsed: 1,
    chronologyConflicts: [],
    cycles: [],
    inaccessibleOriginals: [],
    coverageStatus: "complete" as const,
    globalOriginClaimed: false as const,
  };
  const result = await createAdjudicateClaimsV2()(
    { claims: [adjudicationClaim()], assessments, graphs: [graph] },
    fixture.environment,
  );
  assert.deepEqual(result.data!.decisions[0]!.reasonCodes, ["awaiting_deferred_processing"]);
  assert.equal(fixture.requests.length, 0);
});

test("one secondary report of unknown dependence cannot support a decisive verdict", async () => {
  const report = adjudicationSnapshot(
    "wire_copy",
    "Northbridge recorded 42 incidents in 1998, a wire report said.",
  );
  const assessment = adjudicationAssessment(report, {
    directness: "secondary",
    dependence: "unknown",
  });
  const { result, fixture } = await adjudicate([assessment], [report], {
    draft: () => draft("supported", { supportingAssessmentIds: [assessment.id] }),
  });
  const decision = result.data!.decisions[0]!;
  assert.equal(decision.diagnosticLabel, "unverified");
  assert.deepEqual(decision.reasonCodes, ["insufficient_independent_origins"]);
  assert.equal(fixture.challengeCalls, 0);
});

test("disagreement without a targeted-retrieval capability stays unresolved and explicit", async () => {
  const { snapshots, assessments } = contradictionEvidence();
  const ids = assessments.map(({ id }) => id);
  const { result } = await adjudicate(assessments, snapshots, {
    draft: () => draft("contradicted", { contradictingAssessmentIds: ids }),
    challenge: () => challenge("unverified", []),
  });
  const decision = result.data!.decisions[0]!;
  assert.equal(decision.diagnosticLabel, "contradicted");
  assert.equal(decision.publishedLabel, "unverified");
  assert.equal(decision.challenge.status, "unresolved");
  assert.equal(decision.challenge.targetedRoundsUsed, 0);
  assert.ok(decision.reasonCodes.includes("unresolved_challenge_disagreement"));
  assert.ok(result.issues.some(({ code }) => code === "capability_unavailable"));
});

test("an in-scope probability below the frozen threshold publishes unverified and keeps the probability", async () => {
  const { snapshots, assessments } = contradictionEvidence();
  const ids = assessments.map(({ id }) => id);
  const { result } = await adjudicate(assessments, snapshots, {
    draft: () => draft("contradicted", { contradictingAssessmentIds: ids }),
    challenge: () => challenge("contradicted", ids),
  });
  const calibrated = await calibrate(
    result.data!.decisions,
    assessments,
    snapshots,
    syntheticCalibratorArtifact({ intercept: 0 }),
  );
  const decision = calibrated.data!.decisions[0]!;
  assert.equal(decision.calibration.applicability, "in_scope");
  assert.equal(decision.calibration.calibratedCorrectness, 0.5);
  assert.equal(decision.publishedLabel, "unverified");
  assert.ok(decision.reasonCodes.includes("calibration_out_of_scope"));
  assert.throws(() =>
    decisionSchema.parse({
      ...decision,
      publishedLabel: "contradicted",
      calibration: {
        applicability: "unavailable",
        calibratedCorrectness: null,
        calibratorVersion: null,
        reason: "none",
      },
    }),
  );
});

test("an exhausted shared request cap abstains with an explicit budget reason", async () => {
  const { snapshots, assessments } = contradictionEvidence();
  const { result, fixture } = await adjudicate(
    assessments,
    snapshots,
    { draft: () => draft("contradicted", { contradictingAssessmentIds: [assessments[0]!.id] }) },
    { priorExternalRequests: runContextExample.budget.maxExternalRequests - 1 },
  );
  assert.deepEqual(result.data!.decisions[0]!.reasonCodes, ["budget_exhausted_before_resolution"]);
  assert.equal(fixture.requests.length, 0);
});

test("cancellation fails both stages without partial decisions", async () => {
  const { snapshots, assessments } = contradictionEvidence();
  const controller = new AbortController();
  controller.abort();
  const fixture = createAdjudicationEnvironment({ snapshots, signal: controller.signal });
  const adjudicated = await createAdjudicateClaimsV2()(
    { claims: [adjudicationClaim()], assessments, graphs: [] },
    fixture.environment,
  );
  assert.equal(adjudicated.status, "failed");
  assert.equal(adjudicated.data, null);
  const calibrated = await createCalibrateDecisionsV2({ artifact: null })(
    { claims: [adjudicationClaim()], decisions: [], assessments },
    fixture.environment,
  );
  assert.equal(calibrated.status, "failed");
  assert.ok(fixture.audits.some(({ kind }) => kind === "cancellation"));
});

test("fitting uses grouped out-of-fold calibration data deterministically and never escapes fixture mode", () => {
  const dataset = syntheticCalibrationDataset(12, 6);
  const observations = {
    observationSetVersion: CALIBRATION_OBSERVATION_SET_VERSION,
    datasetId: dataset.datasetId,
    datasetHash: datasetHash(dataset),
    versions: {
      engine: runContextExample.versions.engine,
      prompt: runContextExample.versions.prompt,
      model: runContextExample.versions.model,
      retriever: runContextExample.versions.retriever,
    },
    observations: dataset.claims.map((claim, index) => ({
      datasetClaimId: claim.id,
      diagnosticLabel: "supported" as const,
      language: "en",
      features: Object.fromEntries(
        CALIBRATION_FEATURE_NAMES.map((name) => [
          name,
          name === "independent_origin_groups" ? index % 3 : 0,
        ]),
      ),
    })),
  };
  const policy = {
    ...RELEASE_CALIBRATION_POLICY,
    minGoldObservations: 10,
    minSliceObservations: 10,
    folds: 3,
    allowSyntheticLabels: true,
  };
  const input = {
    dataset,
    observations,
    policy,
    seed: 20260910,
    fittedAt: "2026-09-10T00:00:00.000Z",
  };
  const first = fitCorrectnessCalibrator(input);
  const second = fitCorrectnessCalibrator(input);
  assert.equal(first.status, "fitted");
  assert.deepEqual(first, second);
  if (first.status !== "fitted") return;
  assert.equal(first.artifact.goldKind, "synthetic_fixture");
  assert.equal(first.artifact.dataset.split, "calibration");
  assert.equal(first.artifact.outOfFold.count, 12);
  const context = {
    ...runContextExample,
    versions: { ...runContextExample.versions, calibration: first.artifact.calibratorVersion },
  };
  assert.equal(
    checkCalibratorArtifact(first.artifact, context, "2026-09-14T00:00:00.000Z").status,
    "valid",
  );
  assert.equal(
    checkCalibratorArtifact(
      first.artifact,
      { ...context, executionMode: "live" },
      "2026-09-14T00:00:00.000Z",
    ).status,
    "invalidated",
  );
  assert.equal(
    fitCorrectnessCalibrator({ ...input, policy: RELEASE_CALIBRATION_POLICY }).status,
    "blocked",
  );

  const leaked = structuredClone(dataset);
  leaked.documents[0]!.splitId = "development";
  const refused = fitCorrectnessCalibrator({ ...input, dataset: leaked });
  assert.equal(refused.status, "refused");
});

function syntheticCalibrationDataset(claims: number, groups: number): EvaluationDataset {
  const documents = Array.from({ length: claims }, (_, index) => {
    const text = `Synthetic calibration claim ${index}.`;
    return {
      id: `doc-${index}`,
      text,
      contentHash: contentHash(text),
      language: "en",
      asOfTime: "2026-01-01T00:00:00.000Z",
      acquiredAt: "2026-01-01T00:00:00.000Z",
      sourceUrl: null,
      splitId: "calibration" as const,
      eventGroupId: `event-${index % groups}`,
      sourceFamilyId: `family-${index % groups}`,
    };
  });
  return {
    schemaVersion: "1.0.0",
    datasetId: "synthetic-calibration",
    datasetVersion: "1.0.0",
    license: {
      name: "synthetic",
      url: null,
      redistributionAllowed: true,
      notes: "Synthetic fixture.",
    },
    documents,
    evidenceDocuments: [],
    excerpts: [],
    claims: documents.map((document, index) => ({
      id: `claim-${index}`,
      documentId: document.id,
      text: document.text,
      spans: [{ start: 0, end: document.text.length }],
      material: true,
      checkability: "checkable" as const,
      label: index % 4 === 0 ? ("contradicted" as const) : ("supported" as const),
      evidenceExcerptIds: [],
      origin: "not_applicable" as const,
      goldStatus: "synthetic" as const,
      annotations: [],
      adjudication: null,
    })),
  };
}
