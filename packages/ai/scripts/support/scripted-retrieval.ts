import { createHash } from "node:crypto";
import {
  runContextExample,
  type ClaimV2,
  type DocumentSnapshot,
  type RunBudget,
  type StageResult,
} from "@repo/contracts/core-v2";
import { createCandidateSearchAdapter } from "../../src/core/retrieval/index.js";
import type { AuditEvent, CorePorts, RunEnvironment } from "../../src/core/types.js";

export const RETRIEVAL_FIXTURE_NOW = "2026-09-14T00:00:00.000Z";

export interface ScriptedRetrievalSource {
  url: string;
  content: string;
  intents: Array<
    "neutral" | "supporting" | "disconfirming" | "primary_source" | "date_constrained"
  >;
  fetch: "complete" | "failed" | "truncated";
  publishedAt?: string;
}

export function retrievalClaim(overrides: Partial<ClaimV2> = {}): ClaimV2 {
  return {
    id: "claim_retrieval_fixture",
    documentId: "snap_input_retrieval",
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

export function createScriptedRetrievalEnvironment(options: {
  sources?: ScriptedRetrievalSource[];
  outage?: boolean;
  budget?: Partial<RunBudget>;
  signal?: AbortSignal;
}) {
  const sources = options.sources ?? [];
  const audits: AuditEvent[] = [];
  const stored = new Map<string, DocumentSnapshot>();
  let tick = 0;
  const clock = {
    now: () => RETRIEVAL_FIXTURE_NOW,
    monotonicMs: () => tick++,
  };
  const search = createCandidateSearchAdapter({
    provider: "fixture-web",
    supportsDateRange: true,
    clock,
    client: {
      async search(request) {
        if (options.outage) throw new Error("fixture search API outage");
        return {
          results: sources
            .filter(({ intents }) =>
              intents.includes(request.intent as ScriptedRetrievalSource["intents"][number]),
            )
            .map(({ url }) => ({
              url,
              title: `Record at ${new URL(url).hostname}`,
              snippet: "Discovery snippet is not evidence.",
            })),
          costUsd: 0,
        };
      },
    },
  });
  const ports: CorePorts = {
    search: [search],
    clock,
    audit: {
      sinkId: "fixture-audit",
      async record(event) {
        audits.push(event);
      },
    },
    documents: {
      async acquire(request) {
        const source = sources.find(({ url }) => url === request.url);
        if (source === undefined || source.fetch === "failed") {
          return stage<{ snapshot: DocumentSnapshot }>(
            "failed",
            null,
            [
              {
                code: "provider_failure",
                severity: "error",
                message: "fixture fetch failed",
                claimId: null,
                snapshotId: null,
                url: request.url,
              },
            ],
            1,
          );
        }
        const snapshot = evidenceSnapshot(source, request.role);
        return stage(
          source.fetch === "truncated" ? "partial" : "complete",
          { snapshot },
          source.fetch === "truncated"
            ? [
                {
                  code: "truncation",
                  severity: "warning",
                  message: "fixture truncated",
                  claimId: null,
                  snapshotId: snapshot.id,
                  url: request.url,
                },
              ]
            : [],
          1,
        );
      },
      async acquireFromText() {
        throw new Error("not used");
      },
    },
    snapshots: {
      async put(snapshot) {
        stored.set(snapshot.id, snapshot);
      },
      async get(id) {
        return stored.get(id) ?? null;
      },
      async getMany(ids) {
        return ids.flatMap((id) => stored.get(id) ?? []);
      },
    },
    generation: {
      modelId: "fixture",
      promptVersion: "fixture",
      async generate() {
        throw new Error("not used");
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
    runs: {
      async checkpoint() {},
      async readCheckpoint() {
        return null;
      },
      async finalize() {},
    },
  };
  const environment: RunEnvironment = {
    context: {
      ...runContextExample,
      runId: "run_retrieval_fixture",
      versions: { ...runContextExample.versions, retriever: "core-retriever-2.0.0" },
      budget: { ...runContextExample.budget, ...options.budget },
    },
    ports,
    signal: options.signal ?? new AbortController().signal,
  };
  return { environment, audits, stored };
}

export function inputSnapshot(
  text = "Northbridge recorded 42 incidents in 1998.",
): DocumentSnapshot {
  return snapshot("snap_input_retrieval", null, text, "submitted_input", false);
}

function evidenceSnapshot(source: ScriptedRetrievalSource, role: DocumentSnapshot["role"]) {
  const id = `snap_${createHash("sha256").update(source.url).digest("hex")}`;
  const value = snapshot(id, source.url, source.content, role, source.fetch === "truncated");
  if (source.publishedAt) {
    value.timestampAssertions.push({
      type: "published",
      interval: {
        earliest: source.publishedAt,
        latest: source.publishedAt,
        precision: "day",
        timezone: "UTC",
      },
      source: "provider_api",
      locatorId: null,
    });
  }
  return value;
}

function snapshot(
  id: string,
  url: string | null,
  text: string,
  role: DocumentSnapshot["role"],
  truncated: boolean,
): DocumentSnapshot {
  return {
    id,
    contentHash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    rawContentHash: null,
    originalUrl: url,
    finalUrl: url,
    canonicalUrl: url,
    acquiredAt: RETRIEVAL_FIXTURE_NOW,
    mimeType: "text/html",
    language: "en",
    role,
    normalizedText: text,
    extractionStatus: truncated ? "partial" : "complete",
    extractionMethod: "structured_html",
    limits: {
      byteLimit: 5_000_000,
      characterLimit: 200_000,
      bytesRetained: text.length,
      charactersRetained: text.length,
      truncated,
    },
    locators: text.length
      ? [
          {
            id: `${id}_p1`,
            kind: "paragraph",
            path: "/article/p[1]",
            span: { start: 0, end: text.length },
            boundingBox: null,
            transcriptionUncertain: false,
          },
        ]
      : [],
    timestampAssertions: [],
    discoveryHints: [],
    blobLocator: { status: "unavailable", uri: null },
  };
}

function stage<Data>(
  status: StageResult<Data>["status"],
  data: Data | null,
  issues: StageResult<Data>["issues"],
  externalRequests: number,
): StageResult<Data> {
  return {
    status,
    data,
    issues,
    metrics: {
      startedAt: RETRIEVAL_FIXTURE_NOW,
      completedAt: RETRIEVAL_FIXTURE_NOW,
      durationMs: 1,
      externalRequests,
      inputTokens: null,
      outputTokens: null,
      costUsd: 0,
    },
  };
}
