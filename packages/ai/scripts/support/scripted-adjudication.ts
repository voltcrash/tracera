import {
  runContextExample,
  type DocumentSnapshot,
  type EvidenceAssessment,
  type RunContext,
  type StageMetrics,
} from "@repo/contracts/analysis";
import {
  ADJUDICATION_CHALLENGE_SCHEMA_NAME,
  ADJUDICATION_DRAFT_SCHEMA_NAME,
  type ChallengeProposal,
  type DraftProposal,
  type TargetedEvidence,
  type TargetedReassessment,
} from "../../src/analysis/adjudication/index.js";
import type { AuditEvent, GenerationRequest, RunEnvironment } from "../../src/analysis/types.js";
import { evidenceClaim, evidenceSnapshot } from "./scripted-evidence.js";

export const ADJUDICATION_FIXTURE_NOW = "2026-09-14T00:00:00.000Z";
export const DRAFT_JUSTIFICATION_MARKER = "Draft-only justification marker.";

export const adjudicationClaim = evidenceClaim;

export function adjudicationSnapshot(
  id: string,
  text: string,
  role: DocumentSnapshot["role"] = "evidence",
): DocumentSnapshot {
  return evidenceSnapshot(id, text, { role });
}

export function adjudicationAssessment(
  snapshot: DocumentSnapshot,
  overrides: Partial<EvidenceAssessment> = {},
): EvidenceAssessment {
  const claim = adjudicationClaim();
  return {
    id: `assessment_${snapshot.id}`,
    claimId: claim.id,
    snapshotId: snapshot.id,
    excerpt: {
      span: { start: 0, end: snapshot.normalizedText.length },
      quote: snapshot.normalizedText,
      locatorId: snapshot.locators[0]?.id ?? null,
    },
    relation: "supports",
    applicability: {
      temporal: "applicable",
      entity: "applicable",
      jurisdiction: "applicable",
      scope: "applicable",
    },
    directness: "primary",
    dependencyGroupId: `origin_${snapshot.id}`,
    dependence: "independent",
    dependenceLocators: [],
    method: {
      name: "adjudication-fixture",
      model: null,
      promptVersion: null,
      engineVersion: "core-v2.0.0",
    },
    checks: [
      { check: "citation_reference", result: "pass", detail: "Fixture IDs match." },
      { check: "quote_offsets", result: "pass", detail: "Fixture offsets reproduce the quote." },
    ],
    calculation: null,
    validationStatus: "validated",
    justification: "The acquired record states the scoped figure.",
    ...overrides,
  };
}

export interface ScriptedAdjudicationOptions {
  snapshots: DocumentSnapshot[];
  draft?: (evidenceIds: string[], call: number) => DraftProposal;
  challenge?: (evidenceIds: string[], call: number) => ChallengeProposal;
  signal?: AbortSignal;
  context?: Partial<RunContext>;
}

export function createAdjudicationEnvironment(options: ScriptedAdjudicationOptions) {
  const requests: Array<{ schemaName: string; content: string }> = [];
  const audits: AuditEvent[] = [];
  const store = new Map(options.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  let draftCalls = 0;
  let challengeCalls = 0;
  let tick = 0;
  const environment: RunEnvironment = {
    context: { ...runContextExample, runId: "run_adjudication_fixture", ...options.context },
    signal: options.signal ?? new AbortController().signal,
    ports: {
      generation: {
        modelId: "scripted-adjudication-fixture",
        promptVersion: "fixture",
        async generate<Value>(request: GenerationRequest<Value>) {
          const content = request.untrustedContent.map(({ text }) => text).join("\n");
          requests.push({ schemaName: request.schemaName, content });
          const input = JSON.parse(request.untrustedContent[0]!.text) as {
            evidence: Array<{ id: string }>;
          };
          const ids = input.evidence.map(({ id }) => id);
          let value: unknown;
          if (request.schemaName === ADJUDICATION_DRAFT_SCHEMA_NAME) {
            draftCalls += 1;
            if (options.draft === undefined) throw new Error("No scripted draft.");
            value = options.draft(ids, draftCalls);
          } else if (request.schemaName === ADJUDICATION_CHALLENGE_SCHEMA_NAME) {
            challengeCalls += 1;
            if (options.challenge === undefined) throw new Error("No scripted challenge.");
            value = options.challenge(ids, challengeCalls);
          } else throw new Error(`Unsupported schema ${request.schemaName}.`);
          return {
            value: request.schema.parse(value),
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
            attempts: 1,
          };
        },
      },
      embeddings: {
        modelId: "fixture",
        dimensions: 1024,
        preprocessing: "fixture",
        async embed() {
          throw new Error("not used");
        },
      },
      search: [],
      documents: {
        async acquire() {
          throw new Error("not used");
        },
        async acquireFromText() {
          throw new Error("not used");
        },
      },
      snapshots: {
        async put(snapshot) {
          store.set(snapshot.id, snapshot);
        },
        async get(id) {
          return store.get(id) ?? null;
        },
        async getMany(ids) {
          return ids.flatMap((id) => (store.has(id) ? [store.get(id)!] : []));
        },
      },
      runs: {
        async checkpoint() {},
        async readCheckpoint() {
          return null;
        },
        async finalize() {},
      },
      clock: { now: () => ADJUDICATION_FIXTURE_NOW, monotonicMs: () => tick++ },
      audit: {
        sinkId: "adjudication-fixture",
        async record(event) {
          audits.push(event);
        },
      },
    },
  };
  return {
    environment,
    requests,
    audits,
    get draftCalls() {
      return draftCalls;
    },
    get challengeCalls() {
      return challengeCalls;
    },
  };
}

export function draft(
  label: DraftProposal["label"],
  ids: Partial<
    Pick<
      DraftProposal,
      "supportingAssessmentIds" | "contradictingAssessmentIds" | "correctiveContextAssessmentIds"
    >
  >,
  selfConfidence: number | null = 0.9,
): DraftProposal {
  return {
    claimId: adjudicationClaim().id,
    label,
    supportingAssessmentIds: ids.supportingAssessmentIds ?? [],
    contradictingAssessmentIds: ids.contradictingAssessmentIds ?? [],
    correctiveContextAssessmentIds: ids.correctiveContextAssessmentIds ?? [],
    justification: DRAFT_JUSTIFICATION_MARKER,
    selfConfidence,
  };
}

export function challenge(
  label: ChallengeProposal["label"],
  citedAssessmentIds: string[],
): ChallengeProposal {
  return {
    claimId: adjudicationClaim().id,
    label,
    citedAssessmentIds,
    justification: "Independent reassessment of the supplied evidence.",
  };
}

/** Fixture-only targeted round that returns pre-scripted snapshots and assessments. */
export function scriptedTargetedReassessment(
  added: { snapshots: DocumentSnapshot[]; assessments: EvidenceAssessment[] } = {
    snapshots: [],
    assessments: [],
  },
) {
  const recorded: TargetedEvidence[] = [];
  const reassessment: TargetedReassessment = {
    createRetrieve: () => async () => ({
      status: "complete",
      data: {
        candidates: [],
        snapshots: added.snapshots,
        admittedSnapshotIds: added.snapshots.map(({ id }) => id),
        budgetUsed: { externalRequests: 1, costUsd: 0 },
        stoppingReason: added.snapshots.length === 0 ? "no_results" : "plan_complete",
      },
      issues: [],
      metrics: fixtureMetrics(1),
    }),
    createAssess: () => async () => ({
      status: "complete",
      data: { assessments: added.assessments, sufficiency: [] },
      issues: [],
      metrics: fixtureMetrics(added.snapshots.length),
    }),
    async record(evidence) {
      recorded.push(evidence);
    },
  };
  return { reassessment, recorded };
}

function fixtureMetrics(externalRequests: number): StageMetrics {
  return {
    startedAt: ADJUDICATION_FIXTURE_NOW,
    completedAt: ADJUDICATION_FIXTURE_NOW,
    durationMs: 0,
    externalRequests,
    inputTokens: null,
    outputTokens: null,
    costUsd: 0,
  };
}
