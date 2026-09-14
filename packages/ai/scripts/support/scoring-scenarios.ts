import assert from "node:assert/strict";
import type {
  ClaimLabel,
  ClaimV2,
  Decision,
  EvidenceAssessment,
  InputCoverage,
} from "@repo/contracts/core-v2";
import { scoreReportV2 } from "../../src/core/scoring/index.js";
import {
  adjudicationAssessment,
  adjudicationClaim,
  adjudicationSnapshot,
} from "./scripted-adjudication.js";

export const SCORING_SCENARIOS = [
  "zero-claim-null",
  "all-unverified-null",
  "partial-null",
  "all-contradicted-zero",
  "all-supported-one-hundred",
  "copied-evidence-and-style-invariant",
  "material-mixed-blocks-score",
  "material-misleading-blocks-score",
] as const;

export type ScoringScenario = (typeof SCORING_SCENARIOS)[number];

const AT = "2026-09-14T00:00:00.000Z";

export function scoringClaim(overrides: Partial<ClaimV2> = {}) {
  return adjudicationClaim(overrides);
}

export function scoringAssessment(
  claim: ClaimV2,
  id: string,
  relation: EvidenceAssessment["relation"],
  overrides: Partial<EvidenceAssessment> = {},
) {
  const snapshot = adjudicationSnapshot(id, `Record ${id} supplies assessed context.`);
  return adjudicationAssessment(snapshot, {
    id: `assessment_${id}`,
    claimId: claim.id,
    relation,
    ...overrides,
  });
}

export function scoringDecision(
  claim: ClaimV2,
  publishedLabel: ClaimLabel,
  assessments: EvidenceAssessment[] = [],
): Decision {
  const supportingAssessmentIds = assessments
    .filter(({ relation }) => relation === "supports")
    .map(({ id }) => id);
  const contradictingAssessmentIds = assessments
    .filter(({ relation }) => relation === "contradicts")
    .map(({ id }) => id);
  const correctiveContextAssessmentIds = assessments
    .filter(({ relation }) => relation === "context")
    .map(({ id }) => id);
  const decisive =
    publishedLabel === "supported" ||
    publishedLabel === "contradicted" ||
    publishedLabel === "misleading";
  return {
    claimId: claim.id,
    diagnosticLabel: publishedLabel,
    publishedLabel,
    reasonCodes:
      publishedLabel === "supported"
        ? ["supported_by_admissible_evidence"]
        : publishedLabel === "contradicted"
          ? ["contradicted_by_admissible_evidence"]
          : publishedLabel === "misleading"
            ? ["material_distortion_with_corrective_context"]
            : publishedLabel === "mixed"
              ? ["unresolved_material_conflict"]
              : ["no_admissible_evidence"],
    supportingAssessmentIds,
    contradictingAssessmentIds,
    correctiveContextAssessmentIds,
    justification: "Synthetic scoring fixture decision.",
    challenge: decisive
      ? {
          status: "resolved",
          independentLabel: publishedLabel,
          agreed: true,
          targetedRoundsUsed: 0,
          notes: "Synthetic resolved challenge.",
        }
      : {
          status: publishedLabel === "mixed" ? "unresolved" : "not_required",
          independentLabel: publishedLabel === "mixed" ? "mixed" : null,
          agreed: publishedLabel === "mixed" ? false : null,
          targetedRoundsUsed: 0,
          notes: "No decisive released label.",
        },
    calibration: decisive
      ? {
          applicability: "in_scope",
          calibratedCorrectness: 0.99,
          calibratorVersion: "fixture-calibrator",
          sliceId: "fixture",
        }
      : {
          applicability: "unavailable",
          calibratedCorrectness: null,
          calibratorVersion: null,
          reason: "Not required for this fixture label.",
        },
    rawModelConfidence: null,
    citationIntegrity: decisive ? "valid" : "not_checked",
  };
}

export function scoreFixture(input: {
  claims?: ClaimV2[];
  decisions?: Decision[];
  assessments?: EvidenceAssessment[];
  coverage?: InputCoverage[];
  inputStatus?: "complete" | "partial" | "unavailable" | "failed";
  extractionStatus?: "complete" | "partial" | "unavailable" | "failed";
}) {
  return scoreReportV2({
    claims: input.claims ?? [],
    decisions: input.decisions ?? [],
    assessments: input.assessments ?? [],
    graphs: [],
    coverage: input.coverage ?? [],
    inputStatus: input.inputStatus ?? "complete",
    extractionStatus: input.extractionStatus ?? "complete",
    at: AT,
  });
}

export async function runScoringScenario(id: ScoringScenario) {
  switch (id) {
    case "zero-claim-null": {
      const result = scoreFixture({});
      assert.equal(result.data!.scorecard.factualScore, null);
      assert.deepEqual(result.data!.scorecard.nullReasons, [
        "no_checkable_claims",
        "zero_resolved_denominator",
      ]);
      return;
    }
    case "all-unverified-null": {
      const claims = [scoringClaim()];
      const result = scoreFixture({
        claims,
        decisions: [scoringDecision(claims[0]!, "unverified")],
      });
      assert.equal(result.data!.scorecard.factualScore, null);
      assert.equal(result.data!.scorecard.resolutionCoverage, 0);
      return;
    }
    case "partial-null": {
      const claim = scoringClaim();
      const evidence = scoringAssessment(claim, "partial_support", "supports");
      const result = scoreFixture({
        claims: [claim],
        decisions: [scoringDecision(claim, "supported", [evidence])],
        assessments: [evidence],
        inputStatus: "partial",
        extractionStatus: "partial",
      });
      assert.equal(result.data!.scorecard.factualScore, null);
      assert.ok(result.data!.scorecard.nullReasons.includes("partial_input"));
      assert.ok(result.data!.scorecard.nullReasons.includes("partial_extraction"));
      return;
    }
    case "all-contradicted-zero": {
      const claim = scoringClaim();
      const evidence = scoringAssessment(claim, "contradiction", "contradicts");
      const result = scoreFixture({
        claims: [claim],
        decisions: [scoringDecision(claim, "contradicted", [evidence])],
        assessments: [evidence],
      });
      assert.equal(result.data!.scorecard.factualScore, 0);
      return;
    }
    case "all-supported-one-hundred": {
      const claim = scoringClaim();
      const evidence = scoringAssessment(claim, "support", "supports");
      const result = scoreFixture({
        claims: [claim],
        decisions: [scoringDecision(claim, "supported", [evidence])],
        assessments: [evidence],
      });
      assert.equal(result.data!.scorecard.factualScore, 100);
      return;
    }
    case "copied-evidence-and-style-invariant": {
      const claim = scoringClaim();
      const support = scoringAssessment(claim, "original", "supports");
      const decision = scoringDecision(claim, "supported", [support]);
      const baseline = scoreFixture({
        claims: [claim],
        decisions: [decision],
        assessments: [support],
      });
      const copy = scoringAssessment(claim, "syndicated_copy", "supports", {
        dependencyGroupId: support.dependencyGroupId,
        dependence: "unknown",
      });
      const styledClaim = scoringClaim({
        text: "SHOCKING: Northbridge recorded 42 incidents in 1998!",
        attribution: {
          kind: "attributed_statement",
          attributedTo: "Northbridge",
          attributionSpan: { start: 0, end: 11 },
        },
      });
      const changed = scoreFixture({
        claims: [styledClaim],
        decisions: [decision],
        assessments: [support, copy],
      });
      assert.equal(changed.data!.scorecard.factualScore, baseline.data!.scorecard.factualScore);
      assert.equal(changed.data!.scorecard.evidence.independentOriginGroups, 1);
      assert.ok(
        changed.data!.presentationFindings.some(({ kind }) => kind === "attributed_quotation"),
      );
      return;
    }
    case "material-mixed-blocks-score": {
      const claim = scoringClaim({ material: true });
      const support = scoringAssessment(claim, "mixed_support", "supports");
      const contradiction = scoringAssessment(claim, "mixed_contradiction", "contradicts");
      const result = scoreFixture({
        claims: [claim],
        decisions: [scoringDecision(claim, "mixed", [support, contradiction])],
        assessments: [support, contradiction],
      });
      assert.equal(result.data!.scorecard.factualScore, null);
      assert.ok(result.data!.scorecard.nullReasons.includes("material_mixed_or_misleading_open"));
      return;
    }
    case "material-misleading-blocks-score": {
      const claim = scoringClaim({ material: true });
      const support = scoringAssessment(claim, "stated_assertion", "supports");
      const context = scoringAssessment(claim, "corrective_context", "context");
      const result = scoreFixture({
        claims: [claim],
        decisions: [scoringDecision(claim, "misleading", [support, context])],
        assessments: [support, context],
      });
      assert.equal(result.data!.scorecard.factualScore, null);
      assert.deepEqual(result.data!.presentationFindings[0]!.evidenceAssessmentIds, [context.id]);
      return;
    }
  }
}
