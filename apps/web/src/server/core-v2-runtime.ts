import { randomUUID } from "node:crypto";
import { createAiProvider, safeFetch, type AiProviderConfig, type AiProviderName } from "@repo/ai";
import {
  acceptStoredSnapshots,
  createCoreEmbeddingPort,
  createCoreGenerationPort,
  createProviderOcrPort,
  createRunAnalysisV2,
  createRunStore,
  createSnapshotStore,
  createSystemClock,
  runAnalysisV2,
} from "@repo/ai/core";
import { hashValue } from "@repo/ai/core/hashing";
import { createDocumentAcquisitionPort } from "@repo/ai/core/ingestion";
import {
  createExistingDiscoveryAdapters,
  type CandidateDiscoveryClient,
  type CandidateDiscoveryResult,
  type ExistingDiscoveryClients,
} from "@repo/ai/core/retrieval";
import type { CoreInput, RunAnalysisV2Result } from "@repo/ai/core/types";
import {
  CORE_V2_CONTRACT_VERSION,
  CORE_V2_EVALUATION_BUDGET,
  CORE_V2_SCHEMA_VERSION,
  runContextSchema,
  runReportSchema,
  type CoreIssue,
  type RunBudget,
  type RunContext,
  type RunReport,
  type StageName,
} from "@repo/contracts/core-v2";
import type { CoreStorageRepository, CoreAccessScope } from "@repo/db/core/repository";
import { spendLimitedAiProvider, type AnalysisControlConfig } from "./analysis-controls";

const FOCUSED_PROMPT_VERSION = "core-v2-prompts-1.0.0";
const FOCUSED_RETRIEVER_VERSION = "core-v2-retrieval-1.0.0";
const FOCUSED_EMBEDDING_PREPROCESSING = "core-v2-normalized-text-1.0.0";
const EMBEDDING_DIMENSIONS = 1024;

const TEST_FOCUSED_BUDGET: RunBudget = {
  ...CORE_V2_EVALUATION_BUDGET,
  maxCostUsd: 1,
};

type RuntimeEnvironment = Record<string, string | undefined>;

export interface FocusedRuntimePolicy {
  mode: "fixture" | "live";
  providerConfig: AiProviderConfig | null;
  versions: RunContext["versions"];
  budget: RunBudget;
}

export type FocusedRuntimePolicyResult =
  | { enabled: true; policy: FocusedRuntimePolicy }
  | { enabled: false; code: "core_v2_unavailable"; message: string };

export function focusedRuntimePolicy(environment: RuntimeEnvironment): FocusedRuntimePolicyResult {
  const profile = environment.TRACERA_PROFILE?.trim();
  const mode = environment.TRACERA_ANALYSIS_MODE?.trim();

  if (profile === "test" && mode === "fixture") {
    return {
      enabled: true,
      policy: {
        mode: "fixture",
        providerConfig: null,
        versions: testVersions(),
        budget: TEST_FOCUSED_BUDGET,
      },
    };
  }

  if (profile !== "deployed") {
    return unavailable(
      "Focused Core v2 is available only in the deployed live profile or the test fixture profile.",
    );
  }
  if (mode === "fixture") {
    return unavailable("The deployed profile cannot run deterministic Core v2 fixtures.");
  }
  if (mode !== undefined && mode !== "live") {
    return unavailable("The deployed focused runtime requires TRACERA_ANALYSIS_MODE=live.");
  }

  const provider = parseProvider(environment.AI_PROVIDER);
  if (!provider)
    return unavailable("A supported live AI_PROVIDER is required before analysis can start.");
  const apiKey = required(environment, "AI_API_KEY");
  const model = required(environment, "AI_MODEL");
  const embeddingModel = required(environment, "AI_EMBEDDING_MODEL");
  if (!apiKey || !model || !embeddingModel) {
    return unavailable(
      "AI_API_KEY, AI_MODEL, and AI_EMBEDDING_MODEL must be configured before focused analysis can start.",
    );
  }
  if (provider === "openai-compatible" && !optional(environment, "AI_BASE_URL")) {
    return unavailable("AI_BASE_URL is required for an openai-compatible live provider.");
  }

  const embeddingProviderValue = optional(environment, "AI_EMBEDDING_PROVIDER");
  const embeddingProvider = embeddingProviderValue
    ? parseProvider(embeddingProviderValue)
    : undefined;
  if (embeddingProviderValue && !embeddingProvider) {
    return unavailable("AI_EMBEDDING_PROVIDER is not a supported live provider.");
  }
  if (
    embeddingProvider === "openai-compatible" &&
    !optional(environment, "AI_EMBEDDING_BASE_URL")
  ) {
    return unavailable(
      "AI_EMBEDDING_BASE_URL is required for an openai-compatible embedding provider.",
    );
  }
  if (embeddingProvider && !optional(environment, "AI_EMBEDDING_API_KEY")) {
    return unavailable(
      "AI_EMBEDDING_API_KEY is required when a separate embedding provider is configured.",
    );
  }
  if (provider === "anthropic" && !embeddingProvider) {
    return unavailable(
      "Anthropic needs an explicit AI_EMBEDDING_PROVIDER, key, and model for the Core v2 runtime.",
    );
  }

  const budget = readLiveBudget(environment);
  if (!budget.ok) return unavailable(budget.message);
  const spend = readLiveSpend(environment);
  if (!spend.ok) return unavailable(spend.message);

  const providerConfig: AiProviderConfig = {
    provider,
    apiKey,
    model,
    baseUrl: optional(environment, "AI_BASE_URL"),
    ...(embeddingProvider
      ? {
          embedding: {
            provider: embeddingProvider,
            apiKey: optional(environment, "AI_EMBEDDING_API_KEY")!,
            model: embeddingModel,
            baseUrl: optional(environment, "AI_EMBEDDING_BASE_URL"),
            dimensions: EMBEDDING_DIMENSIONS,
          },
        }
      : {
          embeddingModel,
          embeddingDimensions: EMBEDDING_DIMENSIONS,
        }),
  };

  return {
    enabled: true,
    policy: {
      mode: "live",
      providerConfig,
      versions: {
        engine: "core-v2.0.0",
        prompt: FOCUSED_PROMPT_VERSION,
        model,
        retriever: FOCUSED_RETRIEVER_VERSION,
        embedding: {
          model: embeddingModel,
          dimensions: EMBEDDING_DIMENSIONS,
          preprocessing: FOCUSED_EMBEDDING_PREPROCESSING,
        },
        calibration: null,
      },
      budget: budget.value,
    },
  };
}

export type CoreRuntimeRepository = Pick<
  CoreStorageRepository,
  | "enqueue"
  | "acquireLease"
  | "renewLease"
  | "retry"
  | "requestCancellation"
  | "acknowledgeCancellation"
  | "getRunProgress"
  | "listRuns"
  | "getLatestReport"
  | "checkpoint"
  | "readCheckpoint"
  | "finalize"
  | "putSnapshot"
  | "getSnapshot"
  | "getSnapshots"
>;

export interface FocusedRunExecutionInput {
  repository: CoreRuntimeRepository;
  context: RunContext;
  analysis: { input: CoreInput; seed: number };
  policy: FocusedRuntimePolicy;
  controls: AnalysisControlConfig;
  environment: RuntimeEnvironment;
  signal: AbortSignal;
}

export async function executeFocusedRun(
  input: FocusedRunExecutionInput,
): Promise<RunAnalysisV2Result> {
  if (input.policy.mode !== "live" || input.policy.providerConfig === null) {
    throw new Error("The request-scoped focused runtime has no live provider configuration.");
  }

  const scope: CoreAccessScope = {
    tenantId: input.context.tenantId,
    ownerUserId: input.context.ownerUserId,
    visibility: input.context.visibility,
  };
  await input.repository.enqueue({
    context: input.context,
    stage: "normalize_input",
    payload: { input: input.analysis.input, seed: input.analysis.seed },
    maxAttempts: 1,
  });
  const lease = await input.repository.acquireLease({
    scope,
    runId: input.context.runId,
    workerId: `core-http:${process.pid}:${randomUUID()}`,
    leaseSeconds: input.controls.leaseSeconds,
  });
  if (!lease) {
    await input.repository
      .requestCancellation({ scope, runId: input.context.runId, reason: "operator_request" })
      .catch(() => undefined);
    throw new Error("The focused run could not acquire its request-scoped lease.");
  }

  const identity = {
    scope,
    runId: lease.runId,
    stage: lease.stage,
    attempt: lease.attempt,
    fencingToken: lease.fencingToken,
  } as const;
  const runController = new AbortController();
  let timedOut = false;
  let leaseLost = false;
  const signal = AbortSignal.any([input.signal, runController.signal]);
  const deadline = setTimeout(() => {
    timedOut = true;
    runController.abort(new Error("The focused request elapsed-time bound was reached."));
  }, input.context.budget.maxElapsedMs);
  const renewTimer = setInterval(
    () => {
      void input.repository
        .renewLease({ ...identity, leaseSeconds: input.controls.leaseSeconds })
        .catch(() => {
          leaseLost = true;
          runController.abort(new Error("The focused run lease was lost."));
        });
    },
    Math.max(1_000, Math.floor((input.controls.leaseSeconds * 1_000) / 3)),
  );
  const cancellationTimer = setInterval(() => {
    void input.repository
      .getRunProgress({ scope, runId: input.context.runId })
      .then((progress) => {
        if (progress?.cancellationRequested) {
          runController.abort(new Error("The focused run was canceled by its owner."));
        }
      })
      .catch(() => undefined);
  }, 250);

  try {
    const clock = createSystemClock();
    const provider = spendLimitedAiProvider(
      createAiProvider(input.policy.providerConfig),
      input.policy.providerConfig,
      input.controls,
    );
    const snapshots = acceptStoredSnapshots(
      createSnapshotStore({ repository: input.repository, context: input.context }),
    );
    const runs = createRunStore({ repository: input.repository, context: input.context });
    const searchPorts = createLiveSearchPorts(input.environment, clock);
    const engine = createRunAnalysisV2({
      attempt: lease.attempt,
      fencingToken: lease.fencingToken,
      retrieval: { searchPorts },
    });
    const environment = {
      context: input.context,
      ports: {
        generation: createCoreGenerationPort({
          provider,
          modelId: input.context.versions.model,
          promptVersion: input.context.versions.prompt,
          estimatedGenerationCostUsd: input.controls.generationCostUsd,
          estimatedImageCostUsd: input.controls.imageCostUsd,
        }),
        embeddings: createCoreEmbeddingPort({
          provider,
          modelId: input.context.versions.embedding.model,
          dimensions: input.context.versions.embedding.dimensions,
          preprocessing: input.context.versions.embedding.preprocessing,
          estimatedCostUsd: input.controls.embeddingCostUsd,
        }),
        search: searchPorts,
        documents: createRuntimeDocuments(provider, input, clock),
        snapshots,
        runs,
        clock,
        audit: {
          sinkId: input.context.auditSinkId,
          record: async (event) => console.info(JSON.stringify(event)),
        },
      },
      signal,
    } satisfies Parameters<typeof runAnalysisV2>[1];

    const runPromise = engine(input.analysis, environment);
    const timeout = timeoutSignal(input.context.budget.maxElapsedMs);
    const outcome = await Promise.race([
      runPromise.then(
        (result) => ({ kind: "result" as const, result }),
        (error) => ({ kind: "error" as const, error }),
      ),
      timeout.promise,
    ]);
    timeout.cancel();
    if (outcome.kind === "timeout") {
      timedOut = true;
      void runPromise.catch(() => undefined);
      const report = createBoundedReport(input.context, "unavailable", {
        code: "timeout",
        severity: "error",
        message: "The focused analysis exceeded its configured elapsed-time bound.",
        claimId: null,
        snapshotId: null,
        url: null,
      });
      await runs.finalize({
        runId: lease.runId,
        fencingToken: lease.fencingToken,
        report,
        signal: new AbortController().signal,
      });
      return resultForReport(report);
    }
    if (outcome.kind === "error") throw outcome.error;
    const result = outcome.result;
    if (result.status === "canceled") {
      if (await cancellationRequested(input.repository, scope, input.context.runId)) {
        await input.repository.acknowledgeCancellation(identity);
        return { ...result, report: null, status: "canceled" };
      }
      if (timedOut) {
        const report = createBoundedReport(input.context, "unavailable", {
          code: "timeout",
          severity: "error",
          message: "The focused analysis exceeded its configured elapsed-time bound.",
          claimId: null,
          snapshotId: null,
          url: null,
        });
        await runs.finalize({
          runId: lease.runId,
          fencingToken: lease.fencingToken,
          report,
          signal: new AbortController().signal,
        });
        return resultForReport(report);
      }
      throw new Error("The focused analysis was canceled before it produced a report.");
    }
    if (!result.report) throw new Error("The focused engine returned no terminal report.");
    if (leaseLost) throw new Error("The focused run lease was lost before finalization.");
    const report = runReportSchema.parse(result.report);
    await runs.finalize({
      runId: lease.runId,
      fencingToken: lease.fencingToken,
      report,
      signal: new AbortController().signal,
    });
    return { ...result, report, status: report.status };
  } catch (error) {
    if (await cancellationRequested(input.repository, scope, input.context.runId)) {
      await input.repository.acknowledgeCancellation(identity).catch(() => undefined);
      return {
        status: "canceled",
        report: null,
        issues: [],
        replayManifest: null,
        cost: emptyCost(),
      };
    }
    if (leaseLost || input.signal.aborted) {
      await terminalRetry(input.repository, identity, safeError(error));
      throw new Error("The focused request ended before its report could be saved.");
    }
    const report = createBoundedReport(input.context, timedOut ? "unavailable" : "failed", {
      code: timedOut
        ? "timeout"
        : error instanceof Error && error.name === "AnalysisControlError"
          ? "budget_exhausted"
          : "provider_failure",
      severity: "error",
      message: timedOut
        ? "The focused analysis exceeded its configured elapsed-time bound."
        : error instanceof Error && error.name === "AnalysisControlError"
          ? "The focused analysis reached its configured spend bound."
          : "The focused analysis provider failed before a report could be completed.",
      claimId: null,
      snapshotId: null,
      url: null,
    });
    try {
      const runs = createRunStore({ repository: input.repository, context: input.context });
      await runs.finalize({
        runId: lease.runId,
        fencingToken: lease.fencingToken,
        report,
        signal: new AbortController().signal,
      });
      return resultForReport(report);
    } catch (finalizeError) {
      await terminalRetry(input.repository, identity, safeError(finalizeError));
      throw new Error("The focused failure report could not be saved.");
    }
  } finally {
    clearTimeout(deadline);
    clearInterval(renewTimer);
    clearInterval(cancellationTimer);
  }
}

function createRuntimeDocuments(
  provider: ReturnType<typeof spendLimitedAiProvider>,
  input: FocusedRunExecutionInput,
  clock: ReturnType<typeof createSystemClock>,
) {
  const documents = createDocumentAcquisitionPort({
    now: () => clock.now(),
    monotonicMs: () => clock.monotonicMs(),
    ocr: createProviderOcrPort({
      provider,
      modelId: input.context.versions.model,
    }),
    ocrCostUsd: input.controls.imageCostUsd,
  });
  return {
    ...documents,
    async acquire(request: Parameters<typeof documents.acquire>[0]) {
      return markTransportCost(await documents.acquire(request));
    },
    async acquireImage(request: Parameters<NonNullable<typeof documents.acquireImage>>[0]) {
      const result = await documents.acquireImage(request);
      const costUsd =
        result.metrics.costUsd ??
        (result.metrics.externalRequests > 1 ? input.controls.imageCostUsd : 0);
      return { ...result, metrics: { ...result.metrics, costUsd } };
    },
  };

  function markTransportCost<Value extends { metrics: { costUsd: number | null } }>(result: Value) {
    return result.metrics.costUsd === null
      ? { ...result, metrics: { ...result.metrics, costUsd: 0 } }
      : result;
  }
}

function resultForReport(report: RunReport): RunAnalysisV2Result {
  return {
    status: report.status,
    report,
    issues: report.unresolvedReasons,
    replayManifest: report.replayManifest,
    cost: report.cost,
  };
}

function createBoundedReport(
  context: RunContext,
  status: "unavailable" | "failed",
  failure: CoreIssue,
): RunReport {
  const now = new Date().toISOString();
  const metrics = {
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    externalRequests: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  } as const;
  const report = {
    schemaVersion: CORE_V2_SCHEMA_VERSION,
    contractVersion: CORE_V2_CONTRACT_VERSION,
    runId: context.runId,
    createdAt: now,
    asOfTime: context.asOfTime,
    engineVersion: context.versions.engine,
    visibility: context.visibility,
    status,
    stageOutcomes: [
      { stage: "normalize_input" as const, status: "failed" as const, issues: [failure], metrics },
    ],
    snapshots: [],
    primarySnapshotId: null,
    claims: [],
    candidates: [],
    assessments: [],
    provenance: [],
    decisions: [],
    scorecard: null,
    inputCoverage: [],
    unresolvedReasons: [failure],
    evidenceSetHash: null,
    replayManifest: {
      runId: context.runId,
      versions: context.versions,
      seed: 20260910,
      asOfTime: context.asOfTime,
      inputHash: context.inputHash,
      evidenceSetHash: null,
      snapshotIds: [],
      assessmentIds: [],
      budget: context.budget,
    },
    cost: emptyCost(),
  } satisfies RunReport;
  return runReportSchema.parse(report);
}

function emptyCost() {
  return {
    externalRequests: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    latencyMs: 0,
  };
}

async function terminalRetry(
  repository: CoreRuntimeRepository,
  identity: {
    scope: CoreAccessScope;
    runId: string;
    stage: StageName;
    attempt: number;
    fencingToken: string;
  },
  error: string,
) {
  await repository.retry({ ...identity, error, backoffMs: 0 }).catch(() => undefined);
}

async function cancellationRequested(
  repository: CoreRuntimeRepository,
  scope: CoreAccessScope,
  runId: string,
) {
  return (
    (await repository.getRunProgress({ scope, runId }).catch(() => null))?.cancellationRequested ===
    true
  );
}

function timeoutSignal(milliseconds: number) {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), milliseconds);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function createLiveSearchPorts(
  environment: RuntimeEnvironment,
  clock: ReturnType<typeof createSystemClock>,
) {
  const clients: ExistingDiscoveryClients = {
    googleNews: rssClient((request) => {
      const url = new URL("https://news.google.com/rss/search");
      url.searchParams.set("q", request.query.slice(0, 700));
      url.searchParams.set("hl", "en-US");
      url.searchParams.set("gl", "US");
      url.searchParams.set("ceid", "US:en");
      return readRssResults(url, request.signal);
    }),
    gdelt: jsonClient(async (request) => {
      const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
      url.searchParams.set("query", request.query.slice(0, 700));
      url.searchParams.set("mode", "artlist");
      url.searchParams.set("format", "json");
      url.searchParams.set("maxrecords", String(Math.min(request.limit, 10)));
      const response = await discoveryFetch(url, request.signal);
      const payload = (await response.json()) as {
        articles?: Array<{ title?: string; url?: string; domain?: string; seendate?: string }>;
      };
      return (payload.articles ?? []).flatMap((article) =>
        article.title && article.url && isPublicHttpUrl(article.url)
          ? [
              {
                url: article.url,
                title: article.title,
                snippet: null,
                rating: article.domain ?? null,
              },
            ]
          : [],
      );
    }, 0),
  };
  const factCheckKey = optional(environment, "GOOGLE_FACT_CHECK_API_KEY");
  if (factCheckKey) clients.googleFactCheck = googleFactCheckClient(factCheckKey);
  const newsApiKey = optional(environment, "NEWS_API_KEY");
  if (newsApiKey) clients.newsApi = newsApiClient(newsApiKey);
  return createExistingDiscoveryAdapters(clients, clock);
}

function rssClient(
  read: (
    request: Parameters<CandidateDiscoveryClient["search"]>[0],
  ) => Promise<CandidateDiscoveryResult[]>,
): CandidateDiscoveryClient {
  return {
    async search(request) {
      const results = await read(request);
      // These are public, unmetered discovery transports; this is not a provider usage metric.
      return { results, costUsd: 0 };
    },
  };
}

function jsonClient(
  read: (
    request: Parameters<CandidateDiscoveryClient["search"]>[0],
  ) => Promise<CandidateDiscoveryResult[]>,
  costUsd: number | null = null,
): CandidateDiscoveryClient {
  return {
    async search(request) {
      const results = await read(request);
      return { results, costUsd };
    },
  };
}

async function readRssResults(url: URL, signal: AbortSignal): Promise<CandidateDiscoveryResult[]> {
  const response = await discoveryFetch(url, signal, { "user-agent": "Tracera/2.0" });
  const xml = await response.text();
  return (xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []).flatMap((item) => {
    const title = xmlValue(item, "title");
    const resultUrl = xmlValue(item, "link");
    if (!title || !resultUrl || !isPublicHttpUrl(resultUrl)) return [];
    return [
      {
        url: resultUrl,
        title,
        snippet: xmlValue(item, "description"),
        rating: xmlValue(item, "source"),
      },
    ];
  });
}

function googleFactCheckClient(apiKey: string): CandidateDiscoveryClient {
  return jsonClient(async (request) => {
    const url = new URL("https://factchecktools.googleapis.com/v1alpha1/claims:search");
    url.searchParams.set("query", request.query.slice(0, 700));
    url.searchParams.set("pageSize", String(Math.min(request.limit, 10)));
    url.searchParams.set("key", apiKey);
    const response = await discoveryFetch(url, request.signal);
    const payload = (await response.json()) as {
      claims?: Array<{
        text?: string;
        claimReview?: Array<{ url?: string; title?: string; publisher?: { name?: string } }>;
      }>;
    };
    return (payload.claims ?? []).flatMap((claim) =>
      (claim.claimReview ?? []).flatMap((review) =>
        review.url && isPublicHttpUrl(review.url)
          ? [
              {
                url: review.url,
                title: review.title ?? claim.text ?? null,
                snippet: claim.text ?? null,
                rating: review.publisher?.name ?? null,
              },
            ]
          : [],
      ),
    );
  });
}

function newsApiClient(apiKey: string): CandidateDiscoveryClient {
  return jsonClient(async (request) => {
    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("q", request.query.slice(0, 700));
    url.searchParams.set("pageSize", String(Math.min(request.limit, 10)));
    url.searchParams.set("sortBy", "relevancy");
    const response = await discoveryFetch(url, request.signal, { "X-Api-Key": apiKey });
    const payload = (await response.json()) as {
      articles?: Array<{
        title?: string;
        url?: string;
        description?: string;
        source?: { name?: string };
      }>;
    };
    return (payload.articles ?? []).flatMap((article) =>
      article.title && article.url && isPublicHttpUrl(article.url)
        ? [
            {
              url: article.url,
              title: article.title,
              snippet: article.description ?? null,
              rating: article.source?.name ?? null,
            },
          ]
        : [],
    );
  });
}

async function discoveryFetch(
  url: URL,
  signal: AbortSignal,
  extraHeaders?: Record<string, string>,
) {
  const response = await safeFetch(url, {
    signal,
    headers: { accept: "application/rss+xml, application/json, text/xml", ...extraHeaders },
  });
  if (!response.ok) throw new Error(`Discovery provider returned HTTP ${response.status}.`);
  return response;
}

function xmlValue(item: string, tag: string) {
  const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return (
    match?.[1]
      ?.replace(/^<!\[CDATA\[|\]\]>$/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

function isPublicHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function readLiveBudget(environment: RuntimeEnvironment) {
  const values = {
    maxExternalRequests: readPositiveInteger(environment, "CORE_V2_MAX_EXTERNAL_REQUESTS"),
    maxDiscoveryQueriesPerClaim: readPositiveInteger(
      environment,
      "CORE_V2_MAX_DISCOVERY_QUERIES_PER_CLAIM",
    ),
    maxFetchedCandidatesPerClaim: readPositiveInteger(
      environment,
      "CORE_V2_MAX_FETCHED_CANDIDATES_PER_CLAIM",
    ),
    maxProvenanceHops: readPositiveInteger(environment, "CORE_V2_MAX_PROVENANCE_HOPS"),
    maxTargetedRetrievalRounds: readNonNegativeInteger(
      environment,
      "CORE_V2_MAX_TARGETED_RETRIEVAL_ROUNDS",
    ),
    maxElapsedMs: readPositiveInteger(environment, "CORE_V2_MAX_ELAPSED_MS"),
    maxConcurrentExternalCalls: readPositiveInteger(
      environment,
      "CORE_V2_MAX_CONCURRENT_EXTERNAL_CALLS",
    ),
    maxCostUsd: readPositiveMoney(environment, "CORE_V2_MAX_COST_USD"),
  };
  const invalid = Object.entries(values).find(([, value]) => value === null);
  if (invalid) {
    return {
      ok: false as const,
      message: `The focused runtime requires an explicit ${invalid[0]} budget setting.`,
    };
  }
  if (values.maxElapsedMs! > 300_000) {
    return {
      ok: false as const,
      message: "CORE_V2_MAX_ELAPSED_MS cannot exceed the existing 300-second web request bound.",
    };
  }
  return { ok: true as const, value: values as RunBudget };
}

function readLiveSpend(environment: RuntimeEnvironment) {
  const names = [
    "AI_DAILY_SPEND_LIMIT_USD",
    "AI_ESTIMATED_GENERATION_COST_USD",
    "AI_ESTIMATED_IMAGE_COST_USD",
    "AI_ESTIMATED_EMBEDDING_COST_USD",
  ];
  const missing = names.find((name) => readPositiveMoney(environment, name) === null);
  return missing
    ? {
        ok: false as const,
        message: `The focused runtime requires an explicit positive ${missing} spend setting.`,
      }
    : { ok: true as const };
}

function readPositiveInteger(environment: RuntimeEnvironment, name: string) {
  const value = optional(environment, name);
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function readNonNegativeInteger(environment: RuntimeEnvironment, name: string) {
  const value = optional(environment, name);
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function readPositiveMoney(environment: RuntimeEnvironment, name: string) {
  const value = optional(environment, name);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseProvider(value: string | undefined): AiProviderName | null {
  const supported: AiProviderName[] = [
    "anthropic",
    "gemini",
    "openai",
    "openrouter",
    "openai-compatible",
  ];
  const normalized = value?.trim().toLowerCase();
  return normalized && supported.includes(normalized as AiProviderName)
    ? (normalized as AiProviderName)
    : null;
}

function required(environment: RuntimeEnvironment, name: string) {
  return optional(environment, name);
}

function optional(environment: RuntimeEnvironment, name: string) {
  const value = environment[name]?.trim();
  return value || undefined;
}

function unavailable(message: string): FocusedRuntimePolicyResult {
  return { enabled: false, code: "core_v2_unavailable", message };
}

function testVersions(): RunContext["versions"] {
  return {
    engine: "core-v2.0.0",
    prompt: "core-v2-test-fixture-prompts-1.0.0",
    model: "test-fixture-model",
    retriever: FOCUSED_RETRIEVER_VERSION,
    embedding: {
      model: "test-fixture-embedding",
      dimensions: EMBEDDING_DIMENSIONS,
      preprocessing: FOCUSED_EMBEDDING_PREPROCESSING,
    },
    calibration: null,
  };
}

export function focusedRunContext(
  ownerUserId: string,
  input: CoreInput,
  policy: FocusedRuntimePolicy,
): RunContext {
  return runContextSchema.parse({
    runId: randomUUID(),
    tenantId: `user:${ownerUserId}`,
    ownerUserId,
    visibility: "private",
    inputHash: hashValue(input),
    asOfTime: new Date().toISOString(),
    versions: policy.versions,
    executionMode: policy.mode,
    budget: policy.budget,
    cancellation: { requested: false, requestedAt: null, reason: null },
    auditSinkId: `core-audit:${ownerUserId}`,
  });
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 2_000) : "Focused runtime failure.";
}
