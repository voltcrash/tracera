import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Decision, DocumentSnapshot, EvidenceAssessment } from "@repo/contracts/core-v2";
import {
  createAdjudicateClaimsV2,
  type AdjudicationOptions,
} from "../../src/core/adjudication/index.js";
import {
  CALIBRATION_FEATURE_NAMES,
  CALIBRATION_OBSERVATION_SET_VERSION,
  RELEASE_CALIBRATION_POLICY,
  createCalibrateDecisionsV2,
  fitCorrectnessCalibrator,
} from "../../src/core/calibration/index.js";
import { datasetHash, evaluationDatasetSchema } from "../../evaluation/schemas.js";
import {
  DRAFT_JUSTIFICATION_MARKER,
  adjudicationAssessment,
  adjudicationClaim,
  adjudicationSnapshot,
  calibratedContext,
  challenge,
  createAdjudicationEnvironment,
  draft,
  scriptedTargetedReassessment,
  syntheticCalibratorArtifact,
  type ScriptedAdjudicationOptions,
} from "./scripted-adjudication.js";

export const ADJUDICATION_SCENARIOS = [
  "deterministic-abstention",
  "genuine-contradiction",
  "misleading-corrective-context",
  "unresolved-conflict",
  "stale-calibration-rejection",
  "sealed-test-fit-refused",
  "missing-human-gold-blocked",
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
  const result = await createAdjudicateClaimsV2(options)(
    { claims: [adjudicationClaim()], assessments, graphs: [] },
    fixture.environment,
  );
  return { result, fixture };
}

export async function calibrate(
  decisions: Decision[],
  assessments: EvidenceAssessment[],
  snapshots: DocumentSnapshot[],
  artifact: unknown,
  context = calibratedContext(),
) {
  const fixture = createAdjudicationEnvironment({ snapshots, context });
  return createCalibrateDecisionsV2({ artifact })(
    { claims: [adjudicationClaim()], decisions, assessments },
    fixture.environment,
  );
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
      const calibrated = await calibrate(
        [decision],
        assessments,
        snapshots,
        syntheticCalibratorArtifact(),
      );
      assert.equal(calibrated.data!.decisions[0]!.publishedLabel, "unverified");
      assert.equal(calibrated.data!.decisions[0]!.calibration.calibratedCorrectness, null);
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
      const calibrated = await calibrate(
        [decision],
        assessments,
        snapshots,
        syntheticCalibratorArtifact(),
      );
      const published = calibrated.data!.decisions[0]!;
      assert.equal(published.publishedLabel, "contradicted");
      assert.equal(published.calibration.applicability, "in_scope");
      assert.equal(published.rawModelConfidence, 0.9);
      assert.notEqual(published.calibration.calibratedCorrectness, published.rawModelConfidence);
      return { decision: published };
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
      const calibrated = await calibrate(
        [decision],
        assessments,
        snapshots,
        syntheticCalibratorArtifact(),
      );
      assert.equal(calibrated.data!.decisions[0]!.publishedLabel, "misleading");

      const toneOnly = await adjudicate(assessments, snapshots, {
        draft: () => draft("misleading", { supportingAssessmentIds: [statedId] }),
      });
      const rejected = toneOnly.result.data!.decisions[0]!;
      assert.equal(rejected.diagnosticLabel, "unverified");
      assert.equal(rejected.citationIntegrity, "invalid");
      assert.deepEqual(rejected.reasonCodes, ["citation_validation_failed"]);
      return { decision: calibrated.data!.decisions[0]! };
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
        const calibrated = await calibrate(
          [decision],
          assessments,
          snapshots,
          syntheticCalibratorArtifact(),
        );
        assert.equal(calibrated.data!.decisions[0]!.publishedLabel, "mixed");
      }
      return {};
    }
    case "stale-calibration-rejection": {
      const { snapshots, assessments } = contradictionEvidence();
      const ids = assessments.map(({ id }) => id);
      const { result } = await adjudicate(assessments, snapshots, {
        draft: () => draft("contradicted", { contradictingAssessmentIds: ids }),
        challenge: () => challenge("contradicted", ids),
      });
      const decision = result.data!.decisions[0]!;
      const tampered = {
        ...syntheticCalibratorArtifact(),
        model: { ...syntheticCalibratorArtifact().model, intercept: 9 },
      };
      const cases: Array<
        [string, unknown, ReturnType<typeof calibratedContext>, "unavailable" | "invalidated"]
      > = [
        ["missing", null, calibratedContext(), "unavailable"],
        [
          "model changed",
          syntheticCalibratorArtifact({ model: "retired-model" }),
          calibratedContext(),
          "invalidated",
        ],
        ["tampered", tampered, calibratedContext(), "invalidated"],
        [
          "expired",
          syntheticCalibratorArtifact({ validUntil: "2026-09-02T00:00:00.000Z" }),
          calibratedContext(),
          "invalidated",
        ],
        ["unpinned", syntheticCalibratorArtifact(), {}, "invalidated"],
        [
          "synthetic outside fixture mode",
          syntheticCalibratorArtifact(),
          calibratedContext({ executionMode: "live" }),
          "invalidated",
        ],
      ];
      for (const [name, artifact, context, applicability] of cases) {
        const calibrated = await calibrate([decision], assessments, snapshots, artifact, context);
        const gated = calibrated.data!.decisions[0]!;
        assert.equal(gated.calibration.applicability, applicability, name);
        assert.equal(gated.calibration.calibratedCorrectness, null, name);
        assert.equal(gated.publishedLabel, "unverified", name);
        assert.equal(gated.diagnosticLabel, "contradicted", name);
        assert.equal(gated.rawModelConfidence, 0.9, name);
        assert.ok(gated.reasonCodes.includes("calibration_unavailable"), name);
      }
      return {};
    }
    case "sealed-test-fit-refused":
    case "missing-human-gold-blocked": {
      const dataset = evaluationDatasetSchema.parse(
        JSON.parse(
          await readFile(
            fileURLToPath(
              new URL("../../evaluation/fixtures/invariants.dataset.json", import.meta.url),
            ),
            "utf8",
          ),
        ),
      );
      const claimId = id === "sealed-test-fit-refused" ? "claim-context" : "claim-time";
      const observations = {
        observationSetVersion: CALIBRATION_OBSERVATION_SET_VERSION,
        datasetId: dataset.datasetId,
        datasetHash: datasetHash(dataset),
        versions: {
          engine: "core-v2.0.0",
          prompt: "fixture",
          model: "fixture",
          retriever: "fixture",
        },
        observations: [
          {
            datasetClaimId: claimId,
            diagnosticLabel: id === "sealed-test-fit-refused" ? "misleading" : "supported",
            language: "en",
            features: Object.fromEntries(CALIBRATION_FEATURE_NAMES.map((name) => [name, 0])),
          },
        ],
      };
      const fit = fitCorrectnessCalibrator({
        dataset,
        observations,
        policy: RELEASE_CALIBRATION_POLICY,
        seed: 20260910,
        fittedAt: "2026-09-14T00:00:00.000Z",
      });
      if (id === "sealed-test-fit-refused") {
        assert.equal(fit.status, "refused");
        assert.match(fit.reasons.join(" "), /test partition/u);
      } else {
        assert.equal(fit.status, "blocked");
        assert.equal(fit.counts.goldObservations, 0);
      }
      return {};
    }
  }
}
