import assert from "node:assert/strict";
import type { DocumentSnapshot, EvidenceAssessment } from "@repo/contracts/analysis";
import {
  createAdjudicateClaims,
  type AdjudicationOptions,
} from "../../src/analysis/adjudication/index.js";
import {
  DRAFT_JUSTIFICATION_MARKER,
  adjudicationAssessment,
  adjudicationClaim,
  adjudicationSnapshot,
  challenge,
  createAdjudicationEnvironment,
  draft,
  scriptedTargetedReassessment,
  type ScriptedAdjudicationOptions,
} from "./scripted-adjudication.js";

export const ADJUDICATION_SCENARIOS = [
  "deterministic-abstention",
  "genuine-contradiction",
  "misleading-corrective-context",
  "unresolved-conflict",
] as const;

export type AdjudicationScenario = (typeof ADJUDICATION_SCENARIOS)[number];

const CLAIM_TEXT = "Northbridge recorded 42 incidents in 1998.";

export async function adjudicate(
  assessments: EvidenceAssessment[],
  snapshots: DocumentSnapshot[],
  scripted: Omit<ScriptedAdjudicationOptions, "snapshots"> = {},
  options: AdjudicationOptions = {},
) {
  const fixture = createAdjudicationEnvironment({ ...scripted, snapshots });
  const result = await createAdjudicateClaims(options)(
    { claims: [adjudicationClaim()], assessments, graphs: [] },
    fixture.environment,
  );
  return { result, fixture };
}

export function contradictionEvidence() {
  const input = adjudicationSnapshot(adjudicationClaim().documentId, CLAIM_TEXT, "submitted_input");
  const record = adjudicationSnapshot(
    "police_log",
    "Northbridge police logs show 17 incidents in 1998.",
  );
  const assessment = adjudicationAssessment(record, { relation: "contradicts" });
  return { snapshots: [input, record], assessments: [assessment] };
}

export async function runAdjudicationScenario(id: AdjudicationScenario) {
  switch (id) {
    case "deterministic-abstention": {
      const input = adjudicationSnapshot(
        adjudicationClaim().documentId,
        CLAIM_TEXT,
        "submitted_input",
      );
      const wrongYear = adjudicationSnapshot(
        "wrong_year",
        "Northbridge recorded 42 incidents in 2008.",
      );
      const outOfTime = adjudicationSnapshot("out_of_time", "Northbridge recorded 42 incidents.");
      const review = adjudicationSnapshot("review", "Northbridge may have recorded 42 incidents.");
      const snapshots = [input, wrongYear, outOfTime, review];
      const assessments = [
        adjudicationAssessment(input),
        adjudicationAssessment(wrongYear, {
          validationStatus: "rejected",
          checks: [
            { check: "quote_offsets", result: "pass", detail: "Offsets reproduce the quote." },
            {
              check: "temporal_scope",
              result: "fail",
              detail: "Claim year 1998 differs from 2008.",
            },
          ],
        }),
        adjudicationAssessment(outOfTime, {
          applicability: {
            temporal: "not_applicable",
            entity: "applicable",
            jurisdiction: "applicable",
            scope: "applicable",
          },
        }),
        adjudicationAssessment(review, { validationStatus: "needs_human_review" }),
      ];
      const first = await adjudicate(assessments, snapshots);
      const second = await adjudicate(assessments, snapshots);
      assert.deepEqual(first.result.data, second.result.data);
      const decision = first.result.data!.decisions[0]!;
      assert.equal(decision.diagnosticLabel, "unverified");
      assert.equal(decision.publishedLabel, "unverified");
      assert.deepEqual(decision.reasonCodes, [
        "no_admissible_evidence",
        "evidence_not_applicable_in_time",
      ]);
      assert.equal(first.fixture.requests.length, 0);
      return { decision };
    }
    case "genuine-contradiction": {
      const { snapshots, assessments } = contradictionEvidence();
      const ids = assessments.map(({ id }) => id);
      const { result, fixture } = await adjudicate(assessments, snapshots, {
        draft: () => draft("contradicted", { contradictingAssessmentIds: ids }),
        challenge: () => challenge("contradicted", ids),
      });
      const decision = result.data!.decisions[0]!;
      assert.equal(decision.diagnosticLabel, "contradicted");
      assert.equal(decision.publishedLabel, "unverified");
      assert.equal(decision.challenge.status, "resolved");
      assert.equal(decision.challenge.agreed, true);
      const challengeRequest = fixture.requests.find(({ schemaName }) =>
        schemaName.endsWith("challenge"),
      )!;
      assert.ok(!challengeRequest.content.includes(DRAFT_JUSTIFICATION_MARKER));
      assert.ok(
        !/"(?:label|draft|diagnosticLabel|selfConfidence)"/u.test(challengeRequest.content),
      );
      assert.equal(decision.rawModelConfidence, 0.9);
      return { decision };
    }
    case "misleading-corrective-context": {
      const input = adjudicationSnapshot(
        adjudicationClaim().documentId,
        CLAIM_TEXT,
        "submitted_input",
      );
      const stated = adjudicationSnapshot("stated", CLAIM_TEXT);
      const context = adjudicationSnapshot(
        "definition_change",
        "Northbridge widened its incident definition in 1998, so the 42 incidents are not comparable with earlier years.",
      );
      const snapshots = [input, stated, context];
      const assessments = [
        adjudicationAssessment(stated),
        adjudicationAssessment(context, { relation: "context" }),
      ];
      const [statedId, contextId] = assessments.map(({ id }) => id) as [string, string];
      const { result } = await adjudicate(assessments, snapshots, {
        draft: () =>
          draft("misleading", {
            supportingAssessmentIds: [statedId],
            correctiveContextAssessmentIds: [contextId],
          }),
        challenge: () => challenge("misleading", [statedId, contextId]),
      });
      const decision = result.data!.decisions[0]!;
      assert.equal(decision.diagnosticLabel, "misleading");
      assert.deepEqual(decision.supportingAssessmentIds, [statedId]);
      assert.deepEqual(decision.correctiveContextAssessmentIds, [contextId]);
      const toneOnly = await adjudicate(assessments, snapshots, {
        draft: () => draft("misleading", { supportingAssessmentIds: [statedId] }),
      });
      const rejected = toneOnly.result.data!.decisions[0]!;
      assert.equal(rejected.diagnosticLabel, "unverified");
      assert.equal(rejected.citationIntegrity, "invalid");
      assert.deepEqual(rejected.reasonCodes, ["citation_validation_failed"]);
      return { decision };
    }
    case "unresolved-conflict": {
      const input = adjudicationSnapshot(
        adjudicationClaim().documentId,
        CLAIM_TEXT,
        "submitted_input",
      );
      const record = adjudicationSnapshot(
        "annual_report",
        "Northbridge's annual report lists 42 incidents in 1998.",
      );
      const log = adjudicationSnapshot(
        "police_log",
        "Northbridge police logs show 17 incidents in 1998.",
      );
      const snapshots = [input, record, log];
      const assessments = [
        adjudicationAssessment(record),
        adjudicationAssessment(log, { relation: "contradicts" }),
      ];
      const [supportId, contradictId] = assessments.map(({ id }) => id) as [string, string];
      for (const independentLabel of ["contradicted", "supported"] as const) {
        const targeted = scriptedTargetedReassessment();
        const { result, fixture } = await adjudicate(
          assessments,
          snapshots,
          {
            draft: () => draft("supported", { supportingAssessmentIds: [supportId] }),
            challenge: () =>
              challenge(independentLabel, [
                independentLabel === "supported" ? supportId : contradictId,
              ]),
          },
          { targetedReassessment: targeted.reassessment },
        );
        const decision = result.data!.decisions[0]!;
        assert.equal(decision.diagnosticLabel, "mixed");
        assert.equal(decision.publishedLabel, "mixed");
        assert.equal(decision.challenge.status, "unresolved");
        assert.equal(decision.challenge.independentLabel, independentLabel);
        assert.equal(decision.challenge.targetedRoundsUsed, 1);
        assert.deepEqual(decision.reasonCodes, ["unresolved_material_conflict"]);
        assert.equal(targeted.recorded.length, 1);
        assert.equal(fixture.draftCalls, 1);
        assert.equal(fixture.challengeCalls, 2);
      }
      return {};
    }
  }
}
