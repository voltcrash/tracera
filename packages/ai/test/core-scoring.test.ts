import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { buildPresentationFindings } from "../src/core/framing/index.js";
import { scoreReportV2 } from "../src/core/scoring/index.js";
import {
  SCORING_SCENARIOS,
  runScoringScenario,
  scoreFixture,
  scoringAssessment,
  scoringClaim,
  scoringDecision,
} from "../scripts/support/scoring-scenarios.js";

for (const scenario of SCORING_SCENARIOS) {
  test(`pass-condition fixture: ${scenario}`, async () => {
    await runScoringScenario(scenario);
  });
}

test("duplicates and missing decisions remain visible without receiving fractional labels", () => {
  const canonical = scoringClaim();
  const duplicate = scoringClaim({ id: "claim_duplicate", duplicateOfClaimId: canonical.id });
  const omitted = scoringClaim({ id: "claim_omitted" });
  const result = scoreFixture({
    claims: [canonical, duplicate, omitted],
    decisions: [scoringDecision(canonical, "unverified")],
  });
  assert.equal(result.data!.scorecard.counts.eligibleFactualClaims, 1);
  assert.equal(result.data!.scorecard.counts.omittedClaims, 1);
  assert.equal(result.data!.scorecard.counts.unverified, 1);
  assert.equal(result.data!.scorecard.factualScore, null);
});

test("deferred claims are reported outside the resolved denominator", () => {
  const claim = scoringClaim();
  const deferred = scoringClaim({ id: "claim_deferred", coverageDisposition: "deferred" });
  const support = scoringAssessment(claim, "support_for_deferred_test", "supports");
  const result = scoreFixture({
    claims: [claim, deferred],
    decisions: [scoringDecision(claim, "supported", [support])],
    assessments: [support],
  });
  assert.equal(result.data!.scorecard.counts.deferredClaims, 1);
  assert.equal(result.data!.scorecard.counts.eligibleFactualClaims, 1);
  assert.equal(result.data!.scorecard.factualScore, 100);
});

test("the provisional 0.80 resolution threshold is enforced exactly", () => {
  const claims = Array.from({ length: 5 }, (_, index) =>
    scoringClaim({ id: `claim_threshold_${index}` }),
  );
  const assessments = claims
    .slice(0, 4)
    .map((claim, index) => scoringAssessment(claim, `threshold_${index}`, "supports"));
  const decisions = claims.map((claim, index) =>
    index < 4
      ? scoringDecision(claim, "supported", [assessments[index]!])
      : scoringDecision(claim, "unverified"),
  );
  const result = scoreFixture({ claims, decisions, assessments });
  assert.equal(result.data!.scorecard.resolutionCoverage, 0.8);
  assert.equal(result.data!.scorecard.factualScore, 100);

  const below = scoreFixture({
    claims,
    decisions: decisions.map((decision, index) =>
      index === 3 ? scoringDecision(claims[index]!, "unverified") : decision,
    ),
    assessments,
  });
  assert.equal(below.data!.scorecard.resolutionCoverage, 0.6);
  assert.equal(below.data!.scorecard.factualScore, null);
  assert.ok(below.data!.scorecard.nullReasons.includes("resolution_coverage_below_threshold"));
});

test("presentation observations are descriptive and cannot alter factual score", () => {
  const claim = scoringClaim();
  const support = scoringAssessment(claim, "tone_support", "supports");
  const decision = scoringDecision(claim, "supported", [support]);
  const score = scoreFixture({ claims: [claim], decisions: [decision], assessments: [support] });
  const findings = buildPresentationFindings({
    claims: [claim],
    decisions: [decision],
    assessments: [support],
    observations: [
      {
        kind: "negative_reporting",
        claimId: claim.id,
        submittedSpans: [claim.spans[0]!],
        evidenceAssessmentIds: [],
        description: "The submitted span reports a negative event.",
      },
      {
        kind: "emotional_language",
        claimId: claim.id,
        submittedSpans: [claim.spans[0]!],
        evidenceAssessmentIds: [],
        description: "The submitted span contains an explicitly observed rhetorical flourish.",
      },
    ],
  });
  assert.equal(score.data!.scorecard.factualScore, 100);
  assert.equal(findings.length, 2);
  assert.ok(findings.every(({ evidenceBacked }) => !evidenceBacked));
});

test("evidence-backed omission findings require applicable validated context for the same claim", () => {
  const claim = scoringClaim();
  const context = scoringAssessment(claim, "omission_context", "context");
  const findings = buildPresentationFindings({
    claims: [claim],
    decisions: [],
    assessments: [context],
    observations: [
      {
        kind: "material_context_omission",
        claimId: claim.id,
        submittedSpans: [claim.spans[0]!],
        evidenceAssessmentIds: [context.id],
        description: "The assessed record supplies material omitted context.",
      },
    ],
  });
  assert.equal(findings[0]!.evidenceBacked, true);
  assert.deepEqual(findings[0]!.evidenceAssessmentIds, [context.id]);

  assert.throws(() =>
    buildPresentationFindings({
      claims: [claim],
      decisions: [],
      assessments: [{ ...context, relation: "supports" }],
      observations: [
        {
          kind: "material_context_omission",
          claimId: claim.id,
          submittedSpans: [claim.spans[0]!],
          evidenceAssessmentIds: [context.id],
          description: "Invalid unsupported omission.",
        },
      ],
    }),
  );
});

test("invalid decision citations and out-of-span findings fail closed", () => {
  const claim = scoringClaim();
  const support = scoringAssessment(claim, "invalid_reference", "supports");
  const decision = scoringDecision(claim, "supported", [support]);
  const rejected = scoreReportV2({
    claims: [claim],
    decisions: [decision],
    assessments: [{ ...support, claimId: "claim_elsewhere" }],
    graphs: [],
    coverage: [],
    inputStatus: "complete",
    extractionStatus: "complete",
    at: "2026-09-14T00:00:00.000Z",
  });
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.data, null);

  assert.throws(() =>
    buildPresentationFindings({
      claims: [claim],
      decisions: [],
      assessments: [],
      observations: [
        {
          kind: "negative_reporting",
          claimId: claim.id,
          submittedSpans: [{ start: claim.spans[0]!.end + 1, end: claim.spans[0]!.end + 2 }],
          evidenceAssessmentIds: [],
          description: "Outside the submitted claim.",
        },
      ],
    }),
  );
});
