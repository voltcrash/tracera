import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { runContextExample, type EvidenceAssessment } from "@repo/contracts/analysis";
import { createAdjudicateClaims } from "../src/analysis/adjudication/index.js";
import {
  ADJUDICATION_SCENARIOS,
  adjudicate,
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
  scriptedTargetedReassessment,
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
  const result = await createAdjudicateClaims()(
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
  const result = await createAdjudicateClaims()(
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

test("cancellation fails adjudication without partial decisions", async () => {
  const { snapshots, assessments } = contradictionEvidence();
  const controller = new AbortController();
  controller.abort();
  const fixture = createAdjudicationEnvironment({ snapshots, signal: controller.signal });
  const adjudicated = await createAdjudicateClaims()(
    { claims: [adjudicationClaim()], assessments, graphs: [] },
    fixture.environment,
  );
  assert.equal(adjudicated.status, "failed");
  assert.equal(adjudicated.data, null);
  assert.ok(fixture.audits.some(({ kind }) => kind === "cancellation"));
});

for (const failed of [false, true]) {
  test(`targeted rounds are shared across claims, including failed=${failed} retrieval`, async () => {
    const { snapshots, assessments } = contradictionEvidence();
    const claims = [adjudicationClaim({ id: "claim_one" }), adjudicationClaim({ id: "claim_two" })];
    const evidence = claims.flatMap((claim) =>
      assessments.map((item) => ({ ...item, id: `${item.id}_${claim.id}`, claimId: claim.id })),
    );
    const claimId = (ids: string[]) =>
      ids.some((id) => id.endsWith("claim_one")) ? "claim_one" : "claim_two";
    const fixture = createAdjudicationEnvironment({
      snapshots,
      context: {
        budget: { ...runContextExample.budget, maxTargetedRetrievalRounds: 1, maxCostUsd: null },
      },
      draft: (ids) => ({
        ...draft("contradicted", { contradictingAssessmentIds: ids }),
        claimId: claimId(ids),
      }),
      challenge: (ids) => ({ ...challenge("unverified", []), claimId: claimId(ids) }),
    });
    let retrievals = 0;
    const targeted = scriptedTargetedReassessment();
    const retrieve = targeted.reassessment.createRetrieve!;
    targeted.reassessment.createRetrieve = (usage) => async (input, environment) => {
      retrievals++;
      const result = await retrieve(usage)(input, environment);
      return failed
        ? {
            ...result,
            status: "unavailable",
            data: null,
            issues: [
              {
                code: "provider_outage",
                severity: "warning",
                message: "Fixture unavailable",
                claimId: null,
                snapshotId: null,
                url: null,
              },
            ],
          }
        : result;
    };
    const result = await createAdjudicateClaims({ targetedReassessment: targeted.reassessment })(
      { claims, assessments: evidence, graphs: [] },
      fixture.environment,
    );
    assert.equal(retrievals, 1);
    assert.equal(result.data!.decisions[0]!.challenge.targetedRoundsUsed, 1);
    assert.equal(result.data!.decisions[1]!.challenge.targetedRoundsUsed, 0);
  });
}
