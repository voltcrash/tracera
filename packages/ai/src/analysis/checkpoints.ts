import { z } from "zod";
import {
  claimSchema,
  decisionSchema,
  documentSnapshotSchema,
  evidenceAssessmentSchema,
  evidenceCandidateSchema,
  focusedPublicationPolicySchema,
  inputCoverageSchema,
  nonNegativeIntSchema,
  presentationFindingSchema,
  provenanceGraphSchema,
  scorecardSchema,
  stageResultSchema,
  sufficiencyFeedbackSchema,
  type StageName,
  type StageResult,
} from "@repo/contracts/analysis";
import type { TargetedEvidence } from "./adjudication/types";
import type {
  AdjudicateClaimsData,
  AssessEvidenceData,
  ExtractClaimsData,
  FocusedPublicationData,
  NormalizeInputData,
  RetrieveEvidenceData,
  ScoreReportData,
  TraceOriginsData,
} from "./types";

type Checkpoint<Data, Extra = null> = { result: StageResult<Data>; extra: Extra };
export interface StageCheckpoints {
  normalize_input: Checkpoint<NormalizeInputData>;
  extract_claims: Checkpoint<ExtractClaimsData>;
  retrieve_evidence: Checkpoint<RetrieveEvidenceData>;
  assess_evidence: Checkpoint<
    AssessEvidenceData,
    { targetedRetrieval: StageResult<RetrieveEvidenceData> | null; rounds: number }
  >;
  trace_origins: Checkpoint<
    TraceOriginsData,
    {
      snapshots: NormalizeInputData["snapshots"];
      reassessment: StageResult<AssessEvidenceData>;
    } | null
  >;
  adjudicate_claims: Checkpoint<AdjudicateClaimsData, TargetedEvidence[]>;
  calibrate_decisions: Checkpoint<FocusedPublicationData>;
  score_report: Checkpoint<ScoreReportData>;
}
const snapshots = z.array(documentSnapshotSchema);
const retrieval = z.strictObject({
  candidates: z.array(evidenceCandidateSchema),
  snapshots,
  admittedSnapshotIds: z.array(z.string()),
  budgetUsed: z.strictObject({
    externalRequests: nonNegativeIntSchema,
    costUsd: z.number().nonnegative().finite().nullable(),
  }),
  stoppingReason: z.enum([
    "plan_complete",
    "budget_exhausted",
    "no_results",
    "provider_outage",
    "canceled",
  ]),
});
const assessment = z.strictObject({
  assessments: z.array(evidenceAssessmentSchema),
  sufficiency: z.array(sufficiencyFeedbackSchema),
});
const targetedEvidence = z.strictObject({
  claimId: z.string(),
  round: nonNegativeIntSchema,
  candidates: z.array(evidenceCandidateSchema),
  snapshots,
  admittedSnapshotIds: z.array(z.string()),
  assessments: z.array(evidenceAssessmentSchema),
});
function envelope<Data extends z.ZodType, Extra extends z.ZodType>(data: Data, extra: Extra) {
  return z.strictObject({ version: z.literal(2), result: stageResultSchema(data), extra });
}
const schemas: { [Stage in StageName]: z.ZodType<StageCheckpoints[Stage] & { version: 2 }> } = {
  normalize_input: envelope(
    z
      .strictObject({ snapshots, primarySnapshotId: z.string() })
      .refine(
        (data) => data.snapshots.some((snapshot) => snapshot.id === data.primarySnapshotId),
        "Primary snapshot must exist.",
      ),
    z.null(),
  ),
  extract_claims: envelope(
    z.strictObject({ claims: z.array(claimSchema), coverage: z.array(inputCoverageSchema) }),
    z.null(),
  ),
  retrieve_evidence: envelope(retrieval, z.null()),
  assess_evidence: envelope(
    assessment,
    z.strictObject({
      targetedRetrieval: stageResultSchema(retrieval).nullable(),
      rounds: nonNegativeIntSchema,
    }),
  ),
  trace_origins: envelope(
    z.strictObject({ graphs: z.array(provenanceGraphSchema), newSnapshotIds: z.array(z.string()) }),
    z.strictObject({ snapshots, reassessment: stageResultSchema(assessment) }).nullable(),
  ),
  adjudicate_claims: envelope(
    z.strictObject({ decisions: z.array(decisionSchema) }),
    z.array(targetedEvidence),
  ),
  calibrate_decisions: envelope(
    z.strictObject({ policy: focusedPublicationPolicySchema, decisions: z.array(decisionSchema) }),
    z.null(),
  ),
  score_report: envelope(
    z.strictObject({
      scorecard: scorecardSchema,
      presentationFindings: z.array(presentationFindingSchema),
    }),
    z.null(),
  ),
};

export function readStageCheckpoint<Stage extends StageName>(
  stage: Stage,
  payloadJson: string,
): StageCheckpoints[Stage] | null {
  try {
    const parsed = schemas[stage].safeParse(JSON.parse(payloadJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeStageCheckpoint<Stage extends StageName>(
  stage: Stage,
  checkpoint: StageCheckpoints[Stage],
): string {
  return JSON.stringify(schemas[stage].parse({ version: 2, ...checkpoint }));
}
