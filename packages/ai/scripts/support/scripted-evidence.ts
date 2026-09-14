import { createHash } from "node:crypto";
import { runContextExample, type ClaimV2, type DocumentSnapshot } from "@repo/contracts/core-v2";
import {
  EVIDENCE_ASSESSMENT_PROMPT_VERSION,
  EVIDENCE_ASSESSMENT_SCHEMA_NAME,
  type RawAssessment,
} from "../../src/core/evidence/index.js";
import type { AuditEvent, GenerationRequest, RunEnvironment } from "../../src/core/types.js";

export const EVIDENCE_FIXTURE_NOW = "2026-09-14T00:00:00.000Z";

export function evidenceClaim(overrides: Partial<ClaimV2> = {}): ClaimV2 {
  return {
    id: "claim_evidence_fixture",
    documentId: "snap_input_evidence",
    text: "Northbridge recorded 42 incidents in 1998.",
    spans: [{ start: 0, end: 43 }],
    occurrenceSpans: [],
    retrievalText: "Northbridge 42 incidents 1998",
    proposition: {
      subject: "Northbridge",
      predicate: "recorded",
      object: "42 incidents",
      qualifiers: ["in 1998"],
    },
    attribution: { kind: "direct_assertion", attributedTo: null, attributionSpan: null },
    negated: false,
    quantities: [
      {
        rawText: "42 incidents",
        value: 42,
        unit: "incidents",
        denominatorText: null,
        kind: "count",
      },
    ],
    time: {
      statedText: "1998",
      interval: {
        earliest: "1998-01-01T00:00:00.000Z",
        latest: "1998-12-31T23:59:59.000Z",
        precision: "year",
        timezone: "UTC",
      },
    },
    place: "Northbridge",
    unresolvedContext: [],
    checkability: "checkable",
    material: true,
    parentClaimId: null,
    duplicateOfClaimId: null,
    coverageDisposition: "factual_claim",
    ...overrides,
  };
}

export function evidenceSnapshot(
  id: string,
  text: string,
  options: { url?: string; role?: DocumentSnapshot["role"]; contentHash?: string } = {},
): DocumentSnapshot {
  const url = options.url ?? `https://${id}.example/record`;
  return {
    id,
    contentHash: options.contentHash ?? `sha256:${createHash("sha256").update(text).digest("hex")}`,
    rawContentHash: null,
    originalUrl: url,
    finalUrl: url,
    canonicalUrl: url,
    acquiredAt: EVIDENCE_FIXTURE_NOW,
    mimeType: "text/html",
    language: "en",
    role: options.role ?? "evidence",
    normalizedText: text,
    extractionStatus: "complete",
    extractionMethod: "structured_html",
    limits: {
      byteLimit: 5_000_000,
      characterLimit: 200_000,
      bytesRetained: text.length,
      charactersRetained: text.length,
      truncated: false,
    },
    locators: [
      {
        id: `${id}_p1`,
        kind: "paragraph",
        path: "/article/p[1]",
        span: { start: 0, end: text.length },
        boundingBox: null,
        transcriptionUncertain: false,
      },
    ],
    timestampAssertions: [],
    discoveryHints: [],
    blobLocator: { status: "unavailable", uri: null },
  };
}

export function createScriptedEvidenceEnvironment(
  responder: (request: {
    claim: ClaimV2;
    snapshotId: string;
    passage: string;
    call: number;
  }) => RawAssessment,
  options: { signal?: AbortSignal; cancelRequested?: boolean } = {},
) {
  const audits: AuditEvent[] = [];
  let tick = 0;
  let calls = 0;
  const environment: RunEnvironment = {
    context: {
      ...runContextExample,
      runId: "run_evidence_fixture",
      cancellation: {
        requested: options.cancelRequested ?? false,
        requestedAt: null,
        reason: null,
      },
    },
    signal: options.signal ?? new AbortController().signal,
    ports: {
      generation: {
        modelId: "scripted-evidence-fixture",
        promptVersion: EVIDENCE_ASSESSMENT_PROMPT_VERSION,
        async generate<Value>(request: GenerationRequest<Value>) {
          if (request.schemaName !== EVIDENCE_ASSESSMENT_SCHEMA_NAME)
            throw new Error(`Unsupported schema ${request.schemaName}.`);
          calls += 1;
          const claim = JSON.parse(request.untrustedContent[0]!.text) as ClaimV2;
          const passage = JSON.parse(request.untrustedContent[1]!.text) as {
            snapshotId: string;
            passage: string;
          };
          return {
            value: request.schema.parse(responder({ claim, ...passage, call: calls })),
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
        async put() {},
        async get() {
          return null;
        },
        async getMany() {
          return [];
        },
      },
      runs: {
        async checkpoint() {},
        async readCheckpoint() {
          return null;
        },
        async finalize() {},
      },
      clock: { now: () => EVIDENCE_FIXTURE_NOW, monotonicMs: () => tick++ },
      audit: {
        sinkId: "fixture",
        async record(event) {
          audits.push(event);
        },
      },
    },
  };
  return {
    environment,
    audits,
    get calls() {
      return calls;
    },
  };
}

export function assessmentResponse(
  claim: ClaimV2,
  snapshotId: string,
  quote: string,
  overrides: Partial<RawAssessment> = {},
): RawAssessment {
  return {
    claimId: claim.id,
    snapshotId,
    quote,
    relation: "supports",
    applicability: {
      temporal: "applicable",
      entity: "applicable",
      jurisdiction: "applicable",
      scope: "applicable",
    },
    directness: "primary",
    justification: "The acquired record directly states the scoped fact.",
    ...overrides,
  };
}
