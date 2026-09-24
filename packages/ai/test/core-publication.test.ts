import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  decisionSchema,
  type ClaimLabel,
  type ClaimV2,
  type Decision,
  type EvidenceAssessment,
  type DocumentSnapshot,
} from "@repo/contracts/core-v2";
import {
  createFocusedPublicationV2,
  publishFocusedDecisions,
} from "../src/core/publication/index.js";
import {
  adjudicationAssessment,
  adjudicationClaim,
  adjudicationSnapshot,
  createAdjudicationEnvironment,
} from "../scripts/support/scripted-adjudication.js";

test("focused evidence gates publish supported, contradicted and misleading labels", () => {
  for (const fixture of [supportedFixture(), contradictedFixture(), misleadingFixture()]) {
    const result = publish(fixture);
    const decision = result.decisions[0]!;
    assert.equal(decision.diagnosticLabel, fixture.decision.diagnosticLabel);
    assert.equal(decision.publishedLabel, fixture.decision.diagnosticLabel);
    assert.equal(decision.focusedPublication?.status, "published");
    assert.equal(decision.focusedPublication?.gate, "passed");
    assert.equal(decision.calibration.applicability, "unavailable");
    assert.equal(decision.calibration.calibratedCorrectness, null);
    assert.equal(result.policy.calibration.status, "not_used");
    assert.deepEqual(result.issues, []);
  }
});

test("weak evidence abstains instead of publishing a decisive diagnostic", () => {
  const fixture = supportedFixture();
  fixture.assessments[0] = {
    ...fixture.assessments[0]!,
    directness: "secondary",
    dependence: "unknown",
  };
  const decision = publish(fixture).decisions[0]!;
  assert.equal(decision.diagnosticLabel, "supported");
  assert.equal(decision.publishedLabel, "unverified");
  assert.equal(decision.focusedPublication?.status, "abstained");
  assert.equal(decision.focusedPublication?.gate, "insufficient_evidence");
  assert.ok(decision.reasonCodes.includes("focused_evidence_gate_abstained"));
});

test("missing calibration does not create focused confidence or probability", () => {
  const fixture = supportedFixture();
  const decision = publish(fixture).decisions[0]!;
  assert.equal(decision.publishedLabel, "supported");
  assert.equal(decision.rawModelConfidence, 0.91);
  assert.equal(decision.calibration.applicability, "unavailable");
  assert.equal(decision.calibration.calibratedCorrectness, null);
  assert.equal(decision.focusedPublication?.calibration.status, "not_used");
  assert.equal(decision.focusedPublication?.calibration.probability, null);
  assert.ok(!decision.reasonCodes.includes("calibration_unavailable"));
});

test("invalid citations force focused abstention and an invalid citation state", () => {
  const fixture = supportedFixture();
  fixture.decision = decisionFor(fixture.claims[0]!, {
    supportingAssessmentIds: ["assessment_invented"],
  });
  const result = publish(fixture);
  const decision = result.decisions[0]!;
  assert.equal(decision.publishedLabel, "unverified");
  assert.equal(decision.focusedPublication?.status, "abstained");
  assert.equal(decision.focusedPublication?.gate, "invalid_citation");
  assert.equal(decision.citationIntegrity, "invalid");
  assert.ok(result.issues.some(({ code }) => code === "citation_validation_failed"));
});

test("failed applicability checks force focused abstention", () => {
  const fixture = supportedFixture();
  fixture.assessments[0] = {
    ...fixture.assessments[0]!,
    applicability: {
      temporal: "not_applicable",
      entity: "applicable",
      jurisdiction: "applicable",
      scope: "applicable",
    },
  };
  const result = publish(fixture);
  const decision = result.decisions[0]!;
  assert.equal(decision.publishedLabel, "unverified");
  assert.equal(decision.focusedPublication?.gate, "failed_applicability");
  assert.ok(decision.reasonCodes.includes("evidence_not_applicable_in_time"));
});

test("challenge disagreement preserves mixed evidence or abstains", () => {
  const claim = adjudicationClaim();
  const input = adjudicationSnapshot(claim.documentId, claim.text, "submitted_input");
  const support = adjudicationSnapshot(
    "support_record",
    "Northbridge recorded 42 incidents in 1998.",
  );
  const contradiction = adjudicationSnapshot(
    "contradiction_record",
    "Northbridge police logs show 17 incidents in 1998.",
  );
  const assessments = [
    adjudicationAssessment(support),
    adjudicationAssessment(contradiction, { relation: "contradicts" }),
  ];
  const result = publishFocusedDecisions({
    claims: [claim],
    snapshots: [input, support, contradiction],
    assessments,
    decisions: [
      decisionFor(claim, {
        supportingAssessmentIds: [assessments[0]!.id],
        challenge: {
          status: "unresolved",
          independentLabel: "contradicted",
          agreed: false,
          targetedRoundsUsed: 0,
          notes: "The challenge disagreed with the draft.",
        },
      }),
    ],
  });
  const decision = result.decisions[0]!;
  assert.equal(decision.publishedLabel, "mixed");
  assert.equal(decision.focusedPublication?.gate, "unresolved_conflict");
  assert.equal(decision.challenge.status, "unresolved");
  assert.equal(decision.challenge.agreed, false);
});

test("the focused stage is local and makes no provider requests", async () => {
  const fixture = supportedFixture();
  const environmentFixture = createAdjudicationEnvironment({ snapshots: fixture.snapshots });
  const result = await createFocusedPublicationV2()(
    {
      claims: fixture.claims,
      snapshots: fixture.snapshots,
      decisions: [fixture.decision],
      assessments: fixture.assessments,
    },
    environmentFixture.environment,
  );
  assert.equal(result.status, "complete");
  assert.equal(result.data?.decisions[0]?.publishedLabel, "supported");
  assert.equal(result.metrics.externalRequests, 0);
  assert.equal(environmentFixture.requests.length, 0);
});

interface PublicationFixture {
  claims: ClaimV2[];
  snapshots: DocumentSnapshot[];
  assessments: EvidenceAssessment[];
  decision: Decision;
}

function supportedFixture(): PublicationFixture {
  const claim = adjudicationClaim();
  const input = adjudicationSnapshot(claim.documentId, claim.text, "submitted_input");
  const record = adjudicationSnapshot(
    "support_record",
    "Northbridge recorded 42 incidents in 1998.",
  );
  const assessment = adjudicationAssessment(record);
  return {
    claims: [claim],
    snapshots: [input, record],
    assessments: [assessment],
    decision: decisionFor(claim, { supportingAssessmentIds: [assessment.id] }),
  };
}

function contradictedFixture(): PublicationFixture {
  const claim = adjudicationClaim();
  const input = adjudicationSnapshot(claim.documentId, claim.text, "submitted_input");
  const record = adjudicationSnapshot(
    "contradiction_record",
    "Northbridge police logs show 17 incidents in 1998.",
  );
  const assessment = adjudicationAssessment(record, { relation: "contradicts" });
  return {
    claims: [claim],
    snapshots: [input, record],
    assessments: [assessment],
    decision: decisionFor(claim, {
      diagnosticLabel: "contradicted",
      reasonCodes: ["contradicted_by_admissible_evidence"],
      supportingAssessmentIds: [],
      contradictingAssessmentIds: [assessment.id],
      challenge: resolvedChallenge("contradicted"),
    }),
  };
}

function misleadingFixture(): PublicationFixture {
  const claim = adjudicationClaim();
  const input = adjudicationSnapshot(claim.documentId, claim.text, "submitted_input");
  const stated = adjudicationSnapshot("stated_record", claim.text);
  const context = adjudicationSnapshot(
    "corrective_record",
    "Northbridge widened its incident definition in 1998, so the count is not comparable with earlier years.",
  );
  const assessments = [
    adjudicationAssessment(stated),
    adjudicationAssessment(context, { relation: "context" }),
  ];
  return {
    claims: [claim],
    snapshots: [input, stated, context],
    assessments,
    decision: decisionFor(claim, {
      diagnosticLabel: "misleading",
      reasonCodes: ["material_distortion_with_corrective_context"],
      supportingAssessmentIds: [assessments[0]!.id],
      correctiveContextAssessmentIds: [assessments[1]!.id],
      challenge: resolvedChallenge("misleading"),
    }),
  };
}

function decisionFor(claim: ClaimV2, overrides: Partial<Decision> = {}): Decision {
  return decisionSchema.parse({
    claimId: claim.id,
    diagnosticLabel: "supported",
    publishedLabel: "unverified",
    reasonCodes: ["supported_by_admissible_evidence", "calibration_unavailable"],
    supportingAssessmentIds: [],
    contradictingAssessmentIds: [],
    correctiveContextAssessmentIds: [],
    justification: "The evidence states the scoped proposition.",
    challenge: {
      status: "resolved",
      independentLabel: "supported",
      agreed: true,
      targetedRoundsUsed: 0,
      notes: "The label-blind challenge agreed.",
    },
    calibration: {
      applicability: "unavailable",
      calibratedCorrectness: null,
      calibratorVersion: null,
      reason: "No calibration artifact is installed.",
    },
    rawModelConfidence: 0.91,
    citationIntegrity: "valid",
    ...overrides,
  });
}

function publish(fixture: PublicationFixture) {
  return publishFocusedDecisions({
    claims: fixture.claims,
    snapshots: fixture.snapshots,
    assessments: fixture.assessments,
    decisions: [fixture.decision],
  });
}

function resolvedChallenge(label: ClaimLabel): Decision["challenge"] {
  return {
    status: "resolved",
    independentLabel: label,
    agreed: true,
    targetedRoundsUsed: 0,
    notes: "The label-blind challenge agreed.",
  };
}
