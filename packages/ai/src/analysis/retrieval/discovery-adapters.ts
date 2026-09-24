import { createHash } from "node:crypto";
import {
  evidenceCandidateSchema,
  type EvidenceCandidate,
  type StageResult,
} from "@repo/contracts/analysis";
import type { ClockPort, SearchPort, SearchRequest } from "../types";
import type { PrimarySourceResolverPort } from "./types";

export interface CandidateDiscoveryResult {
  url: string;
  title?: string | null;
  snippet?: string | null;
  rating?: string | null;
}

export interface CandidateDiscoveryClient {
  search(request: Omit<SearchRequest, "signal"> & { signal: AbortSignal }): Promise<{
    results: CandidateDiscoveryResult[];
    costUsd: number | null;
  }>;
}

export interface ExistingDiscoveryClients {
  genericWeb?: CandidateDiscoveryClient;
  googleFactCheck?: CandidateDiscoveryClient;
  newsApi?: CandidateDiscoveryClient;
  gdelt?: CandidateDiscoveryClient;
  googleNews?: CandidateDiscoveryClient;
  bingNews?: CandidateDiscoveryClient;
}

export function createExistingDiscoveryAdapters(
  clients: ExistingDiscoveryClients,
  clock: ClockPort,
): SearchPort[] {
  const definitions: Array<[keyof ExistingDiscoveryClients, string, boolean]> = [
    ["genericWeb", "generic-web", true],
    ["googleFactCheck", "google-fact-check", true],
    ["newsApi", "news-api", true],
    ["gdelt", "gdelt", true],
    ["googleNews", "google-news", false],
    ["bingNews", "bing-news", false],
  ];
  return definitions.flatMap(([key, provider, supportsDateRange]) => {
    const client = clients[key];
    return client === undefined
      ? []
      : [createCandidateSearchAdapter({ provider, supportsDateRange, client, clock })];
  });
}

export function createCandidateSearchAdapter(options: {
  provider: string;
  supportsDateRange: boolean;
  client: CandidateDiscoveryClient;
  clock: ClockPort;
}): SearchPort {
  return {
    provider: options.provider,
    supportsDateRange: options.supportsDateRange,
    async search(request): Promise<StageResult<{ candidates: EvidenceCandidate[] }>> {
      const startedAt = options.clock.now();
      const started = options.clock.monotonicMs();
      try {
        const response = await options.client.search(request);
        const candidates = response.results.slice(0, request.limit).map((result, index) =>
          evidenceCandidateSchema.parse({
            id: candidateId(request.claimId, options.provider, result.url),
            claimId: request.claimId,
            query: request.query,
            queryIntent: request.intent,
            provider: options.provider,
            rank: index + 1,
            discoveredAt: options.clock.now(),
            proposedUrl: result.url,
            title: result.title ?? null,
            snippet: result.snippet ?? null,
            providerRating: result.rating ?? null,
            admissible: false,
          }),
        );
        return result<{ candidates: EvidenceCandidate[] }>(
          "complete",
          { candidates },
          [],
          startedAt,
          options.clock.now(),
          options.clock.monotonicMs() - started,
          response.costUsd,
        );
      } catch (error) {
        return result<{ candidates: EvidenceCandidate[] }>(
          "failed",
          null,
          [
            {
              code: request.signal.aborted ? "cancellation_requested" : "provider_outage",
              severity: "error",
              message: error instanceof Error ? error.message : "Search provider failed.",
              claimId: request.claimId,
              snapshotId: null,
              url: null,
            },
          ],
          startedAt,
          options.clock.now(),
          options.clock.monotonicMs() - started,
          null,
        );
      }
    },
  };
}

export function createPrimarySourceResolverAdapter(options: {
  provider: string;
  client: {
    resolve(request: {
      claimId: string;
      candidateUrls: string[];
      limit: number;
      signal: AbortSignal;
    }): Promise<{ results: CandidateDiscoveryResult[]; costUsd: number | null }>;
  };
  clock: ClockPort;
}): PrimarySourceResolverPort {
  return {
    provider: options.provider,
    async resolve(request) {
      const startedAt = options.clock.now();
      const started = options.clock.monotonicMs();
      try {
        const response = await options.client.resolve({
          claimId: request.claim.id,
          candidateUrls: request.candidates.map(({ proposedUrl }) => proposedUrl),
          limit: request.limit,
          signal: request.signal,
        });
        const query = `primary source for ${request.claim.text}`;
        const candidates = response.results.slice(0, request.limit).map((item, index) =>
          evidenceCandidateSchema.parse({
            id: candidateId(request.claim.id, options.provider, item.url),
            claimId: request.claim.id,
            query,
            queryIntent: "primary_source",
            provider: options.provider,
            rank: index + 1,
            discoveredAt: options.clock.now(),
            proposedUrl: item.url,
            title: item.title ?? null,
            snippet: item.snippet ?? null,
            providerRating: item.rating ?? null,
            admissible: false,
          }),
        );
        return result(
          "complete",
          { candidates },
          [],
          startedAt,
          options.clock.now(),
          options.clock.monotonicMs() - started,
          response.costUsd,
        );
      } catch (error) {
        return result<{ candidates: EvidenceCandidate[] }>(
          "failed",
          null,
          [
            {
              code: request.signal.aborted ? "cancellation_requested" : "provider_outage",
              severity: "error",
              message: error instanceof Error ? error.message : "Primary-source resolver failed.",
              claimId: request.claim.id,
              snapshotId: null,
              url: null,
            },
          ],
          startedAt,
          options.clock.now(),
          options.clock.monotonicMs() - started,
          null,
        );
      }
    },
  };
}

function candidateId(claimId: string, provider: string, url: string) {
  return `cand_${createHash("sha256").update(`${claimId}\0${provider}\0${url}`).digest("hex")}`;
}

function result<Data>(
  status: "complete" | "failed",
  data: Data | null,
  issues: StageResult<Data>["issues"],
  startedAt: string,
  completedAt: string,
  durationMs: number,
  costUsd: number | null,
): StageResult<Data> {
  return {
    status,
    data,
    issues,
    metrics: {
      startedAt,
      completedAt,
      durationMs: Math.max(0, durationMs),
      externalRequests: 1,
      inputTokens: null,
      outputTokens: null,
      costUsd,
    },
  };
}
