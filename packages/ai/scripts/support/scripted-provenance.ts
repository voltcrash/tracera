import { createHash } from "node:crypto";
import {
  runContextExample,
  type ClaimV2,
  type DocumentSnapshot,
  type EvidenceAssessment,
  type StageMetrics,
} from "@repo/contracts/core-v2";
import type { GenerationRequest, RunEnvironment } from "../../src/core/types.js";
import type {
  ArchiveLookupPort,
  ProvenanceRetrievalController,
} from "../../src/core/provenance/index.js";

export const PROVENANCE_NOW = "2026-09-14T00:00:00.000Z";
export const PROVENANCE_CLAIM_TEXT = "Northbridge recorded 42 incidents in 1998.";

export function provenanceClaim(): ClaimV2 {
  return {
    id: "claim_provenance_fixture",
    documentId: "snap_input_provenance",
    text: PROVENANCE_CLAIM_TEXT,
    spans: [{ start: 0, end: PROVENANCE_CLAIM_TEXT.length }],
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
  };
}

export function provenanceSnapshot(
  id: string,
  url: string,
  suffix = "",
  timestamps: DocumentSnapshot["timestampAssertions"] = [],
  role: DocumentSnapshot["role"] = "evidence",
  includeClaim = true,
): DocumentSnapshot {
  const text = `${includeClaim ? PROVENANCE_CLAIM_TEXT : ""}${suffix}`;
  return {
    id,
    contentHash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    rawContentHash: null,
    originalUrl: url,
    finalUrl: url,
    canonicalUrl: url,
    acquiredAt: PROVENANCE_NOW,
    mimeType: "text/html",
    language: "en",
    role,
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
    timestampAssertions: timestamps,
    discoveryHints: [],
    blobLocator: { status: "unavailable", uri: null },
  };
}

export function provenanceAssessment(
  snapshot: DocumentSnapshot,
  overrides: Partial<EvidenceAssessment> = {},
): EvidenceAssessment {
  return {
    id: `assessment_${snapshot.id}`,
    claimId: "claim_provenance_fixture",
    snapshotId: snapshot.id,
    excerpt: {
      span: { start: 0, end: PROVENANCE_CLAIM_TEXT.length },
      quote: PROVENANCE_CLAIM_TEXT,
      locatorId: snapshot.locators[0]!.id,
    },
    relation: "supports",
    applicability: {
      temporal: "applicable",
      entity: "applicable",
      jurisdiction: "applicable",
      scope: "applicable",
    },
    directness: "secondary",
    dependencyGroupId: `origin_${snapshot.id}`,
    dependence: "independent",
    dependenceLocators: [],
    method: {
      name: "provenance-fixture",
      model: null,
      promptVersion: null,
      engineVersion: "core-v2.0.0",
    },
    checks: [{ check: "quote_offsets", result: "pass", detail: "Exact fixture quote." }],
    calculation: null,
    validationStatus: "validated",
    justification: "The immutable fixture contains the scoped claim.",
    ...overrides,
  };
}

export function createProvenanceEnvironment(options: { signal?: AbortSignal } = {}) {
  let tick = 0;
  let assessmentCalls = 0;
  const audits: Array<{ kind: string; message: string }> = [];
  const environment: RunEnvironment = {
    context: { ...runContextExample, runId: "run_provenance_fixture" },
    signal: options.signal ?? new AbortController().signal,
    ports: {
      generation: {
        modelId: "provenance-fixture",
        promptVersion: "evidence-assessment-v2.0.0",
        async generate<Value>(request: GenerationRequest<Value>) {
          assessmentCalls += 1;
          const claim = JSON.parse(request.untrustedContent[0]!.text) as ClaimV2;
          const passage = JSON.parse(request.untrustedContent[1]!.text) as {
            snapshotId: string;
            passage: string;
          };
          const value = request.schema.parse({
            claimId: claim.id,
            snapshotId: passage.snapshotId,
            quote: PROVENANCE_CLAIM_TEXT,
            relation: "supports",
            applicability: {
              temporal: "applicable",
              entity: "applicable",
              jurisdiction: "applicable",
              scope: "applicable",
            },
            directness: "secondary",
            justification: "The acquired traversal snapshot contains the scoped claim.",
          });
          return {
            value,
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
      clock: { now: () => PROVENANCE_NOW, monotonicMs: () => tick++ },
      audit: {
        sinkId: "provenance-fixture",
        async record(event) {
          audits.push({ kind: event.kind, message: event.message });
        },
      },
    },
  };
  return {
    environment,
    audits,
    get assessmentCalls() {
      return assessmentCalls;
    },
  };
}

export function scriptedProvenanceRetrieval(
  snapshotsByUrl: Map<string, DocumentSnapshot>,
): ProvenanceRetrievalController {
  return {
    async retrieveReference(request) {
      const snapshot = snapshotsByUrl.get(request.reference.url);
      return {
        status: "complete",
        data: {
          candidates: [],
          snapshots: snapshot === undefined ? [] : [snapshot],
          admittedSnapshotIds: snapshot === undefined ? [] : [snapshot.id],
          budgetUsed: { externalRequests: 1, costUsd: 0 },
          stoppingReason: snapshot === undefined ? "no_results" : "plan_complete",
        },
        issues: [],
        metrics: fixtureMetrics(1),
      };
    },
  };
}

export function scriptedArchive(
  capturesByUrl: Map<
    string,
    Array<{ captureUrl: string; originalUrl: string; observedAt: string }>
  >,
): ArchiveLookupPort {
  return {
    provider: "fixture-archive",
    async lookup(request) {
      const captures = (capturesByUrl.get(request.url) ?? []).map((capture) => ({
        captureUrl: capture.captureUrl,
        originalUrl: capture.originalUrl,
        observedAt: {
          earliest: capture.observedAt,
          latest: capture.observedAt,
          precision: "day" as const,
          timezone: "UTC",
        },
      }));
      return {
        status: "complete",
        data: { captures },
        issues: [],
        metrics: fixtureMetrics(1),
      };
    },
  };
}

function fixtureMetrics(externalRequests: number): StageMetrics {
  return {
    startedAt: PROVENANCE_NOW,
    completedAt: PROVENANCE_NOW,
    durationMs: 0,
    externalRequests,
    inputTokens: null,
    outputTokens: null,
    costUsd: 0,
  };
}
