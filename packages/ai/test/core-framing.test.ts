import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { buildPresentationFindings } from "../src/analysis/framing/index.js";
import {
  scoringAssessment,
  scoringClaim,
  scoringDecision,
} from "../scripts/support/scripted-scoring.js";

test("presentation observations do not supply evidence", () => {
  const claim = scoringClaim();
  const support = scoringAssessment(claim, "tone_support", "supports");
  const findings = buildPresentationFindings({
    claims: [claim],
    decisions: [scoringDecision(claim, "supported", [support])],
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
  assert.equal(findings.length, 2);
  assert.ok(findings.every(({ evidenceBacked }) => !evidenceBacked));
});

test("evidence-backed omission findings require applicable validated context for the same claim", () => {
  const claim = scoringClaim();
  const context = scoringAssessment(claim, "omission_context", "context");
  const observations = [
    {
      kind: "material_context_omission" as const,
      claimId: claim.id,
      submittedSpans: [claim.spans[0]!],
      evidenceAssessmentIds: [context.id],
      description: "The assessed record supplies material omitted context.",
    },
  ];
  const findings = buildPresentationFindings({
    claims: [claim],
    decisions: [],
    assessments: [context],
    observations,
  });
  assert.equal(findings[0]!.evidenceBacked, true);
  assert.deepEqual(findings[0]!.evidenceAssessmentIds, [context.id]);

  assert.throws(() =>
    buildPresentationFindings({
      claims: [claim],
      decisions: [],
      assessments: [{ ...context, relation: "supports" }],
      observations,
    }),
  );
});

test("presentation findings reject spans outside the submitted claim", () => {
  const claim = scoringClaim();
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
