import { randomUUID } from "node:crypto";
import { createAiProvider, safeFetch } from "@repo/ai";
import {
  acceptStoredSnapshots,
  createAnalysisEmbeddingPort,
  createAnalysisGenerationPort,
  createProviderOcrPort,
  createRunAnalysis,
  createRunStore,
  createSnapshotStore,
  createSystemClock,
  runAnalysis,
} from "@repo/ai/analysis";
import { createDocumentAcquisitionPort } from "@repo/ai/analysis/ingestion";
import {
  createExistingDiscoveryAdapters,
  type CandidateDiscoveryClient,
  type CandidateDiscoveryResult,
  type ExistingDiscoveryClients,
} from "@repo/ai/analysis/retrieval";
import type { RunInput, RunAnalysisResult } from "@repo/ai/analysis/types";
import {
  ANALYSIS_CONTRACT_VERSION,
  ANALYSIS_SCHEMA_VERSION,
  runReportSchema,
  type AnalysisIssue,
  type RunContext,
  type RunReport,
  type StageName,
} from "@repo/contracts/analysis";
import { reserveProviderSpend, settleProviderSpend } from "@repo/db";
import type { AnalysisRepository, AnalysisAccessScope } from "@repo/db/analysis/repository";
import { spendLimitedAiProvider, type AnalysisControlConfig } from "./analysis-controls";
import { optional, type AnalysisRuntimePolicy, type RuntimeEnvironment } from "./analysis-policy";

export type AnalysisRuntimeRepository = Pick<
  AnalysisRepository,
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

export interface AnalysisRunExecutionInput {
  repository: AnalysisRuntimeRepository;
  context: RunContext;
  analysis: { input: RunInput; seed: number };
  policy: AnalysisRuntimePolicy;
  controls: AnalysisControlConfig;
  environment: RuntimeEnvironment;
  signal: AbortSignal;
}

export async function executeFocusedRun(
  input: AnalysisRunExecutionInput,
): Promise<RunAnalysisResult> {
  if (input.policy.mode !== "live" || input.policy.providerConfig === null) {
    throw new Error("The request-scoped focused runtime has no live provider configuration.");
  }

  const scope: AnalysisAccessScope = {
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
    workerId: `analysis-http:${process.pid}:${randomUUID()}`,
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
      { reserveProviderSpend, settleProviderSpend },
    );
    const snapshots = acceptStoredSnapshots(
      createSnapshotStore({ repository: input.repository, context: input.context }),
    );
    const runs = createRunStore({ repository: input.repository, context: input.context });
    const searchPorts = createLiveSearchPorts(input.environment, clock);
    const engine = createRunAnalysis({
      attempt: lease.attempt,
      fencingToken: lease.fencingToken,
      retrieval: { searchPorts },
    });
    const environment = {
      context: input.context,
      ports: {
        generation: createAnalysisGenerationPort({
          provider,
          modelId: input.context.versions.model,
          promptVersion: input.context.versions.prompt,
          estimatedGenerationCostUsd: input.controls.generationCostUsd,
          estimatedImageCostUsd: input.controls.imageCostUsd,
        }),
        embeddings: createAnalysisEmbeddingPort({
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
    } satisfies Parameters<typeof runAnalysis>[1];

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
  input: AnalysisRunExecutionInput,
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

function resultForReport(report: RunReport): RunAnalysisResult {
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
  failure: AnalysisIssue,
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
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    contractVersion: ANALYSIS_CONTRACT_VERSION,
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
  repository: AnalysisRuntimeRepository,
  identity: {
    scope: AnalysisAccessScope;
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
  repository: AnalysisRuntimeRepository,
  scope: AnalysisAccessScope,
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

function safeError(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 2_000) : "Focused runtime failure.";
}
