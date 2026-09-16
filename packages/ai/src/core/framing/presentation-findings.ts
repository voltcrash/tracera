import { createHash } from "node:crypto";
import {
  claimSchema,
  decisionSchema,
  evidenceAssessmentSchema,
  presentationFindingSchema,
  type ClaimV2,
  type Decision,
  type EvidenceAssessment,
  type PresentationFinding,
  type Span,
} from "@repo/contracts/core-v2";
import type { PresentationObservation } from "./types";

export class FramingValidationError extends Error {}

export function buildPresentationFindings(input: {
  claims: ClaimV2[];
  decisions: Decision[];
  assessments: EvidenceAssessment[];
  observations?: PresentationObservation[];
}): PresentationFinding[] {
  const claims = uniqueById(
    input.claims.map((claim) => claimSchema.parse(claim)),
    "claim",
  );
  const assessments = uniqueById(
    input.assessments.map((assessment) => evidenceAssessmentSchema.parse(assessment)),
    "assessment",
  );
  const decisions = input.decisions.map((decision) => decisionSchema.parse(decision));
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const assessmentById = new Map(assessments.map((assessment) => [assessment.id, assessment]));
  const findings: PresentationFinding[] = [];

  for (const claim of claims) {
    if (claim.duplicateOfClaimId !== null || claim.coverageDisposition === "deferred") continue;
    if (
      claim.attribution.kind !== "attributed_statement" ||
      claim.attribution.attributionSpan === null
    )
      continue;
    validateSubmittedSpans(claim, [claim.attribution.attributionSpan]);
    findings.push(
      finding({
        kind: "attributed_quotation",
        claimId: claim.id,
        submittedSpans: [claim.attribution.attributionSpan],
        evidenceAssessmentIds: [],
        evidenceBacked: false,
        description: "The submitted text presents this assertion as an attributed statement.",
      }),
    );
  }

  for (const decision of decisions) {
    if (decision.publishedLabel !== "misleading") continue;
    const claim = requireClaim(claimById, decision.claimId);
    const evidenceAssessmentIds = [...new Set(decision.correctiveContextAssessmentIds)].sort();
    validateCorrectiveEvidence(claim, evidenceAssessmentIds, assessmentById);
    findings.push(
      finding({
        kind: "material_skew",
        claimId: claim.id,
        submittedSpans: claim.spans,
        evidenceAssessmentIds,
        evidenceBacked: true,
        description:
          "Assessed corrective context shows that the submitted assertion creates a material distortion.",
      }),
    );
  }

  for (const observation of input.observations ?? []) {
    const claim = requireClaim(claimById, observation.claimId);
    validateSubmittedSpans(claim, observation.submittedSpans);
    const evidenceBacked =
      observation.kind === "material_context_omission" || observation.kind === "material_skew";
    if (evidenceBacked) {
      validateCorrectiveEvidence(claim, observation.evidenceAssessmentIds, assessmentById);
    } else if (observation.evidenceAssessmentIds.length > 0) {
      throw new FramingValidationError("Text-observed findings cannot cite evidence assessments.");
    }
    findings.push(
      finding({
        ...observation,
        evidenceBacked,
      }),
    );
  }

  return [...new Map(findings.map((item) => [item.id, item])).values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}

function validateCorrectiveEvidence(
  claim: ClaimV2,
  ids: string[],
  assessmentById: Map<string, EvidenceAssessment>,
) {
  if (ids.length === 0)
    throw new FramingValidationError("Evidence-backed findings require corrective context.");
  for (const id of ids) {
    const assessment = assessmentById.get(id);
    if (assessment === undefined)
      throw new FramingValidationError(`Unknown corrective-context assessment: ${id}.`);
    if (
      assessment.claimId !== claim.id ||
      assessment.relation !== "context" ||
      assessment.validationStatus !== "validated" ||
      Object.values(assessment.applicability).some((value) => value !== "applicable")
    ) {
      throw new FramingValidationError(
        `Corrective-context assessment ${id} is not validated and fully applicable to claim ${claim.id}.`,
      );
    }
  }
}

function validateSubmittedSpans(claim: ClaimV2, spans: Span[]) {
  if (spans.length === 0) throw new FramingValidationError("A finding requires a submitted span.");
  const sourceSpans = [...claim.spans, ...claim.occurrenceSpans];
  for (const span of spans) {
    if (!sourceSpans.some((source) => source.start <= span.start && span.end <= source.end)) {
      throw new FramingValidationError(
        `Finding span ${span.start}:${span.end} is outside claim ${claim.id}'s submitted spans.`,
      );
    }
  }
}

function finding(
  input: Omit<PresentationFinding, "id"> & { claimId: string },
): PresentationFinding {
  const id = `finding_${createHash("sha256")
    .update(
      JSON.stringify({
        claimId: input.claimId,
        kind: input.kind,
        spans: input.submittedSpans,
        evidence: input.evidenceAssessmentIds,
        description: input.description,
      }),
    )
    .digest("hex")}`;
  const { claimId: _, ...value } = input;
  return presentationFindingSchema.parse({ id, ...value });
}

function requireClaim(claimById: Map<string, ClaimV2>, id: string) {
  const claim = claimById.get(id);
  if (claim === undefined) throw new FramingValidationError(`Unknown finding claim: ${id}.`);
  return claim;
}

function uniqueById<Value extends { id: string }>(values: Value[], label: string) {
  const map = new Map<string, Value>();
  for (const value of values) {
    if (map.has(value.id)) throw new FramingValidationError(`Duplicate ${label} ID: ${value.id}.`);
    map.set(value.id, value);
  }
  return [...map.values()];
}
