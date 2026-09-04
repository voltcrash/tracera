import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  applyEditorialDomainTrustReview,
  checkDatabase,
  configureDatabase,
  findGroundZeroCorpusHistory,
  findLatestCheckByRawInput,
  findRelatedStoryCheck,
  findReusableExactCheck,
  findReusableImageCheck,
  getCheckById,
  getMediaDietPreference,
  getDomainTrustHistory,
  getTraceAppearances,
  getTraceTimeline,
  listChecks,
  mediaDietReport,
  optedInMediaDietRecipients,
  persistCheck,
  recordTraceAppearance,
  recordDomainOutcomeSignals,
  setMediaDietPreference,
} from "@repo/db";
import {
  aggregateScore,
  analyzeFraming,
  createAiProvider,
  extractClaims,
  retrieveSources,
  retrieveArchiveHistory,
  scoreClaim,
  normalizeInput,
  traceGroundZero,
  type AiProvider,
  type AiProviderConfig,
  type AiProviderName,
  type ClaimVerdict,
  type EvidenceSource,
  type FramingAnalysis,
  type NormalizedInput,
  type TraceraScore,
} from "@repo/ai";
import { Redis } from "@upstash/redis";
import type { AnalysisErrorResponse, AnalysisResponse } from "@repo/contracts";
import { authenticatedUser, type AuthBindings } from "./auth";
import { AnalysisError, publicAnalysisError } from "./analysis-errors";
import { apiRelativePath } from "./base-path";
import { allowedCorsOrigin } from "./cors-origin";
import { reanalysisPolicy } from "./reanalysis-policy";
import {
  authenticatePublicApiKey,
  consumePublicApiQuota,
  parseFirstPartyAnalysisInput,
  parsePublicAnalysisInput,
  PUBLIC_API_VERSION,
  publicOpenApiDocument,
  type PublicQuotaResult,
} from "./public-api";

export type Bindings = AuthBindings & {
  DATABASE_URL?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  [key: string]: string | undefined;
};

export const app = new Hono<{ Bindings: Bindings }>();
let upstash: Redis | undefined;
let upstashConfig: string | undefined;
const currentUserByRequest = new WeakMap<Request, ReturnType<typeof authenticatedUser>>();

const DATABASE_FREE_PATHS = new Set(["/", "/v1", "/v1/openapi.json"]);

app.use("*", async (context, next) => {
  if (!DATABASE_FREE_PATHS.has(apiRelativePath(context.req.path))) {
    configureDatabase(context.env.DATABASE_URL);
  }
  await next();
});
app.use("/*", async (context, next) =>
  cors({
    origin: (origin) => allowedCorsOrigin(origin, context.env?.WEB_ORIGIN),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-API-Key"],
    exposeHeaders: ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After"],
    credentials: true,
  })(context, next),
);
function upstashRedis(env: Bindings) {
  const url = env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return undefined;

  const config = `${url}:${token}`;
  if (!upstash || upstashConfig !== config) {
    upstash = new Redis({ url, token });
    upstashConfig = config;
  }
  return upstash;
}

type PublicAccessQuotaResult =
  | PublicQuotaResult
  | {
      allowed: false;
      status: 503;
      code: "quota_unavailable";
      message: string;
    };

async function publicApiQuota(
  context: Context<{ Bindings: Bindings }>,
  keyId: string,
): Promise<PublicAccessQuotaResult> {
  const redis = upstashRedis(context.env);
  if (!redis) {
    return {
      allowed: false,
      status: 503,
      code: "quota_unavailable",
      message: "Public API quotas are temporarily unavailable.",
    };
  }

  const minuteLimit = configuredPositiveInteger(
    context.env.PUBLIC_API_RATE_LIMIT_PER_MINUTE ?? process.env.PUBLIC_API_RATE_LIMIT_PER_MINUTE,
    30,
    10_000,
  );
  const dailyLimit = configuredPositiveInteger(
    context.env.PUBLIC_API_DAILY_QUOTA ?? process.env.PUBLIC_API_DAILY_QUOTA,
    1_000,
    1_000_000,
  );
  return consumePublicApiQuota(redis, keyId, { minuteLimit, dailyLimit });
}

function configuredPositiveInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

async function checkRedis(env: Bindings) {
  const cache = upstashRedis(env);
  if (!cache) return "not configured";

  return cache.ping();
}

app.get("/", (context) => context.json({ message: "Hello from Tracera API." }));

app.get("/v1/openapi.json", (context) => context.json(publicOpenApiDocument));
app.get("/v1", (context) =>
  context.json({
    apiVersion: PUBLIC_API_VERSION,
    name: "Tracera Public API",
    openapi: "/v1/openapi.json",
  }),
);

app.use("/v1/*", async (context, next) => {
  const configuredKeys =
    context.env.PUBLIC_API_KEYS ??
    process.env.PUBLIC_API_KEYS ??
    context.env.PUBLIC_API_KEY ??
    process.env.PUBLIC_API_KEY;
  if (!configuredKeys) {
    return context.json(
      {
        apiVersion: PUBLIC_API_VERSION,
        error: {
          code: "api_unavailable",
          message: "Public API access is not configured.",
        },
      },
      503,
    );
  }
  const access = await authenticatePublicApiKey(context.req.header("x-api-key"), configuredKeys);
  if (!access.authenticated || !access.keyId) {
    return context.json(
      {
        apiVersion: PUBLIC_API_VERSION,
        error: {
          code: "unauthorized",
          message: "A valid API key is required.",
        },
      },
      401,
    );
  }
  const quota = await publicApiQuota(context, access.keyId).catch(
    (error): PublicAccessQuotaResult => {
      console.warn("Public API quota check failed", error);
      return {
        allowed: false,
        status: 503,
        code: "quota_unavailable",
        message: "Public API quotas are temporarily unavailable.",
      };
    },
  );
  if (!quota.allowed) {
    if ("retryAfter" in quota) {
      context.header("Retry-After", String(quota.retryAfter));
    }
    return context.json(
      {
        apiVersion: PUBLIC_API_VERSION,
        error: { code: quota.code, message: quota.message },
      },
      quota.status,
    );
  }
  context.header("RateLimit-Limit", String(quota.limit));
  context.header("RateLimit-Remaining", String(quota.remaining));
  context.header("RateLimit-Reset", String(quota.resetAt));
  context.header("Cache-Control", "no-store");
  await next();
});

app.get("/v1/checks", async (context) => {
  const page = positiveInteger(context.req.query("page"), 1, 10_000);
  const pageSize = positiveInteger(context.req.query("pageSize"), 20, 100);
  const query = (context.req.query("q") ?? "").slice(0, 200);
  const result = await listChecks(page, pageSize, query);
  return context.json({
    apiVersion: PUBLIC_API_VERSION,
    data: result.checks.map(({ visibility: _visibility, rawInput, ...check }) => ({
      ...check,
      summary: rawInput,
    })),
    pagination: {
      page,
      pageSize,
      total: result.total,
      totalPages: Math.ceil(result.total / pageSize),
    },
  });
});

app.post("/v1/checks", async (context) => {
  const contentLength = Number(context.req.header("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 7_100_000) {
    return context.json(
      {
        apiVersion: PUBLIC_API_VERSION,
        error: {
          code: "payload_too_large",
          message: "Request body is too large.",
        },
      },
      413,
    );
  }
  const parsed = parsePublicAnalysisInput(await context.req.json().catch(() => null));
  if (!parsed.success) {
    return context.json(
      {
        apiVersion: PUBLIC_API_VERSION,
        error: { code: "invalid_request", message: parsed.error },
      },
      400,
    );
  }
  const result = await runAnalysis(context, parsed.data);
  if ("error" in result.payload) {
    const failure = publicAnalysisErrorFromPayload(result.payload);
    return context.json(
      {
        apiVersion: PUBLIC_API_VERSION,
        error: {
          code: failure.code,
          message: failure.message,
        },
      },
      result.status,
    );
  }
  return context.json({ apiVersion: PUBLIC_API_VERSION, ...result.payload }, result.status);
});

app.get("/v1/checks/:id", async (context) => {
  const id = context.req.param("id");
  if (!isUuid(id)) {
    return context.json(
      {
        apiVersion: PUBLIC_API_VERSION,
        error: { code: "not_found", message: "Trace not found." },
      },
      404,
    );
  }
  const check = await getCheckById(id);
  return check
    ? context.json({ apiVersion: PUBLIC_API_VERSION, data: publicCheck(check) })
    : context.json(
        {
          apiVersion: PUBLIC_API_VERSION,
          error: { code: "not_found", message: "Trace not found." },
        },
        404,
      );
});

function publicCheck(check: NonNullable<Awaited<ReturnType<typeof getCheckById>>>) {
  return {
    id: check.id,
    input: {
      type: check.inputType,
      // Avoid returning a multi-megabyte data URI. Image provenance metadata
      // and the structured analysis remain available below.
      value: check.inputType === "image" ? null : check.rawInput,
      sourceUrl: check.sourceUrl,
      sourceDomain: check.sourceDomain,
      publishedAt: check.publishedAt,
    },
    claims: check.analysis.claims,
    traceraScore: check.analysis.score ?? check.traceraScore,
    framingAnalysis: check.analysis.framing ?? null,
    groundZero: check.groundZero,
    createdAt: check.createdAt,
  };
}

app.get("/auth/me", async (context) => {
  const user = await currentUser(context);
  return user ? context.json({ user }) : context.json({ error: "Not authenticated." }, 401);
});
app.get("/reports/media-diet", async (context) => {
  const user = await currentUser(context);
  if (!user) return context.json({ error: "Not authenticated." }, 401);
  return context.json({
    report: await mediaDietReport(user.id),
    preference: await getMediaDietPreference(user.id),
  });
});
app.put("/reports/media-diet/preferences", async (context) => {
  const user = await currentUser(context);
  const body = await context.req.json().catch(() => null);
  if (!user) return context.json({ error: "Not authenticated." }, 401);
  const frequency = body?.frequency === "weekly" ? "weekly" : "monthly";
  await setMediaDietPreference(user.id, Boolean(body?.enabled), frequency);
  return context.json({ preference: await getMediaDietPreference(user.id) });
});
app.post("/internal/reports/media-diet/deliver", async (context) => {
  if (
    !process.env.INTERNAL_WORKER_TOKEN ||
    context.req.header("x-tracera-worker-token") !== process.env.INTERNAL_WORKER_TOKEN
  )
    return context.json({ error: "Unauthorized" }, 401);
  const recipients = await optedInMediaDietRecipients();
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_FROM_EMAIL;
  if (!apiKey || !from)
    return context.json({
      delivered: 0,
      skipped: recipients.length,
      reason: "Email delivery is not configured.",
    });
  await Promise.all(
    recipients.map(async (recipient) => {
      const report = await mediaDietReport(recipient.id, recipient.frequency === "weekly" ? 7 : 30);
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [recipient.email],
          subject: "Your Tracera media-diet report",
          text: `In the last ${report.periodDays} days, you checked ${report.totalChecks} items. Average source reputation: ${report.averageSourceReputation ?? "not enough data"}/100. Average signal: ${report.averageSignal ?? "not enough data"}/100.`,
        }),
      });
      if (!response.ok) throw new Error(`Media-diet delivery failed with HTTP ${response.status}.`);
    }),
  );
  return context.json({ delivered: recipients.length });
});

app.get("/health", async (context) => {
  try {
    const [database, cache] = await Promise.all([checkDatabase(), checkRedis(context.env)]);

    return context.json({ status: "ok", services: { database, cache } });
  } catch (error) {
    return context.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : "Health check failed",
      },
      503,
    );
  }
});

app.get("/internal/domains/:domain/trust-history", async (context) => {
  if (!authorizedDomainTrustAdmin(context)) return context.json({ error: "Unauthorized." }, 401);
  return context.json({
    events: await getDomainTrustHistory(
      context.req.param("domain"),
      positiveInteger(context.req.query("limit"), 100, 500),
    ),
  });
});

app.post("/internal/domains/:domain/trust-review", async (context) => {
  if (!authorizedDomainTrustAdmin(context)) return context.json({ error: "Unauthorized." }, 401);
  const body = await context.req.json().catch(() => null);
  const score = typeof body?.score === "number" ? body.score : Number.NaN;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!Number.isFinite(score) || score < 0 || score > 1 || reason.length < 10)
    return context.json({ error: "Provide a score from 0 to 1 and a review reason." }, 400);
  const user = await currentUser(context);
  return context.json({
    review: await applyEditorialDomainTrustReview({
      domain: context.req.param("domain"),
      score,
      reason,
      reviewerUserId: user?.id,
    }),
  });
});

type AnalysisProgress = {
  stage: string;
  message: string;
  claimIndex?: number;
  claimCount?: number;
};
type ProgressEmitter = (progress: AnalysisProgress) => void;

const MAX_ANALYSIS_BODY_BYTES = 7_100_000;

app.post("/analyze", async (context) => {
  if (requestBodyIsTooLarge(context)) {
    return context.json({ error: "Request body is too large." }, 413);
  }
  const parsed = parseFirstPartyAnalysisInput(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: parsed.error }, 400);
  const body = parsed.data;
  if (!(await canRunAnalysis(context, body))) {
    return context.json({ error: "Sign in or create an account to start a fact-check." }, 401);
  }
  const quotaResponse = await enforceFirstPartyAnalysisQuota(context);
  if (quotaResponse) return quotaResponse;
  const result = await runAnalysis(context, body);
  return context.json(result.payload, result.status);
});

app.post("/analyze/stream", async (context) => {
  if (requestBodyIsTooLarge(context)) {
    return context.json({ error: "Request body is too large." }, 413);
  }
  const parsed = parseFirstPartyAnalysisInput(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: parsed.error }, 400);
  const body = parsed.data;
  if (!(await canRunAnalysis(context, body))) {
    return context.json({ error: "Sign in or create an account to start a fact-check." }, 401);
  }
  const quotaResponse = await enforceFirstPartyAnalysisQuota(context);
  if (quotaResponse) return quotaResponse;
  const encoder = new TextEncoder();
  let cancelled = false;
  const analysisController = new AbortController();
  const analysisSignal = AbortSignal.any([context.req.raw.signal, analysisController.signal]);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown) => {
        if (cancelled) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      emit("progress", {
        stage: "accepted",
        message: "Trace accepted for analysis.",
      });
      heartbeat = setInterval(() => emit("heartbeat", { timestamp: Date.now() }), 15_000);
      void runAnalysis(context, body, (progress) => emit("progress", progress), analysisSignal)
        .then((result) => {
          emit(result.status < 400 ? "complete" : "error", result.payload);
          if (!cancelled) controller.close();
        })
        .catch((error) => {
          if (analysisSignal.aborted) {
            cancelled = true;
            return;
          }
          const failure = publicAnalysisError(error);
          emit("error", {
            error: failure.message,
            code: failure.code,
          });
          if (!cancelled) controller.close();
        })
        .finally(() => {
          if (heartbeat) clearInterval(heartbeat);
        });
    },
    cancel() {
      cancelled = true;
      analysisController.abort(new Error("Analysis stream was cancelled by the client."));
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});

async function runAnalysis(
  context: Context<{ Bindings: Bindings }>,
  body: unknown,
  emit: ProgressEmitter = () => undefined,
  signal: AbortSignal = context.req.raw.signal,
): Promise<
  | { payload: AnalysisResponse; status: 200 | 201 }
  | { payload: AnalysisErrorResponse; status: 422 | 503 }
> {
  try {
    signal.throwIfAborted();
    emit({
      stage: "normalizing",
      message: "Reading and normalizing the submission.",
    });
    const user = await currentUser(context);
    const visibility = requestedVisibility(body, user?.id);
    const aiConfiguration = configuredAiConfiguration();
    const provider = createAiProvider(aiConfiguration);
    const normalized = await normalizeWithStoredFallback(body, provider, signal);
    emit({
      stage: "embedding",
      message: "Checking for recent and related traces.",
    });
    const inputEmbedding = await provider.embed(normalized.text, { signal });
    const forceReanalysis = Boolean(
      body && typeof body === "object" && (body as { forceReanalysis?: unknown }).forceReanalysis,
    );
    const initialPolicy = reanalysisPolicy({
      inputType: normalized.inputType,
      publishedAt: normalized.publishedAt,
    });
    // This environment value is an operational safety cap, not the product
    // duration. The freshness policy chooses the actual reuse window.
    const cacheHours = Math.min(
      initialPolicy.dedupHours,
      environmentNumber("DEDUP_MAX_AGE_HOURS", 24, 1, 24 * 30),
    );
    const cached = forceReanalysis
      ? null
      : normalized.inputType === "image"
        ? await findReusableImageCheck(
            normalized.rawInput,
            inputEmbedding,
            cacheHours,
            environmentNumber("IMAGE_DEDUP_SIMILARITY_THRESHOLD", 0.98, 0.9, 1),
            user?.id,
          )
        : await findReusableExactCheck(normalized.rawInput, cacheHours, user?.id);

    // A previous version stored empty analyses when a URL was sent as text.
    // Never serve an incomplete cache entry. Image checks may validly finish
    // without a relevant external source, so a stored claim is sufficient.
    if (
      cached &&
      (normalized.inputType === "image"
        ? cached.analysis.claims.length > 0
        : hasRetrievedEvidence(cached.analysis.claims))
    ) {
      await recordTraceAppearance({
        checkId: cached.id,
        sourceUrl: normalized.sourceUrl,
        sourceDomain: normalized.sourceDomain,
        occurrenceType: "exact_resubmission",
      });
      emit({
        stage: "reused",
        message: "A recent identical trace was reused.",
      });
      return {
        status: 200,
        payload: analysisResponse({
          cached: true,
          reuse: {
            state: "reused_exact",
            expiresAt: cached.expiresAt,
            policyBand: initialPolicy.band,
            policy: `${initialPolicy.reason} Similar stories are analyzed again and only prior verified claims are used as context.`,
          },
          check: { id: cached.id, createdAt: cached.createdAt },
          claims: cached.analysis.claims as ClaimVerdict[],
          traceraScore: cached.analysis.score as TraceraScore,
        }),
      };
    }

    const auditLog: Array<{ stage: string; prompt: string }> = [];
    const result = await analyzeText(normalized, provider, auditLog, emit, signal);
    signal.throwIfAborted();
    const submittedSource: EvidenceSource[] =
      normalized.sourceUrl && normalized.publishedAt
        ? [
            {
              id: "submitted-source",
              type: "web_search",
              title: normalized.sourceDomain ?? "Submitted publisher",
              url: normalized.sourceUrl,
              canonicalUrl: normalized.sourceUrl,
              sourceDomain: normalized.sourceDomain,
              publishedAt: normalized.publishedAt,
              publisherPublishedAt: normalized.publishedAt,
            },
          ]
        : [];
    const groundZeroSources = [
      ...submittedSource,
      ...result.claims.flatMap((claim) => claim.consideredSources),
    ];
    const groundZeroHistory = await findGroundZeroCorpusHistory(
      [
        normalized.sourceUrl,
        ...groundZeroSources.map((source) => source.canonicalUrl ?? source.url),
      ].filter((url): url is string => Boolean(url)),
      user?.id,
    );
    const archiveHistory = await retrieveArchiveHistory(groundZeroSources, signal);
    signal.throwIfAborted();
    emit({
      stage: "origin",
      message: "Tracing the earliest known publication.",
    });
    const groundZero = traceGroundZero(groundZeroSources, groundZeroHistory, archiveHistory);
    const relatedStory = await findRelatedStoryCheck(
      inputEmbedding,
      environmentNumber("STORY_SIMILARITY_THRESHOLD", 0.84, 0, 1),
      environmentNumber("STORY_MAX_AGE_HOURS", 24 * 90, 1, 24 * 3650),
      visibility,
      user?.id,
    );
    const completedPolicy = reanalysisPolicy({
      inputType: normalized.inputType,
      publishedAt: normalized.publishedAt,
    });
    const stored = await persistCheck({
      rawInput: normalized.rawInput,
      inputType: normalized.inputType,
      sourceUrl: normalized.sourceUrl,
      sourceDomain: normalized.sourceDomain,
      publishedAt: normalized.publishedAt,
      inputEmbedding,
      traceraScore: result.score,
      analysis: {
        claims: result.claims,
        score: result.score,
        framing: result.framing,
      },
      claims: result.claims.map((claim, index) => ({
        claimText: claim.claim.claimText,
        claimType: claim.claim.claimType,
        checkability: claim.claim.checkability,
        verdict: claim.verdict,
        confidence: claim.confidence,
        reasoning: claim.reasoning,
        evidenceQuality: claim.evidenceQuality,
        embedding: result.claimEmbeddings[index] ?? [],
      })),
      groundZero,
      prompts: [
        {
          stage: "provider_configuration",
          provider: aiConfiguration.provider,
          model: aiConfiguration.model,
          embeddingProvider: aiConfiguration.embedding?.provider ?? aiConfiguration.provider,
          embeddingModel: aiConfiguration.embedding?.model ?? aiConfiguration.embeddingModel,
        },
        ...auditLog,
      ],
      ownerUserId: user?.id,
      visibility,
      supersedesCheckId: relatedStory?.id,
      lineageReason: relatedStory ? "related_story" : "first_check",
    });
    await recordDomainOutcomeSignals({
      checkId: stored.id,
      signals: domainOutcomeSignals(result.claims),
      apply: environmentBoolean(
        context.env.DOMAIN_TRUST_AUTO_REFINE ?? process.env.DOMAIN_TRUST_AUTO_REFINE,
        false,
      ),
    }).catch((error) => console.warn("Could not record domain outcome signals", error));

    emit({
      stage: "persisted",
      message: "The completed evidence trail was saved.",
    });
    return {
      status: 201,
      payload: analysisResponse({
        cached: false,
        check: stored,
        claims: result.claims,
        traceraScore: result.score,
        framingAnalysis: result.framing,
        groundZero,
        inputMetadata: normalized.imageMetadata,
        reuse: {
          state: forceReanalysis ? "reanalyzed" : "fresh",
          relatedContextClaims: relatedContextCount(result.claims),
          policyBand: completedPolicy.band,
          policy: completedPolicy.reason,
        },
      }),
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    console.error("Analysis failed", error);
    const failure = publicAnalysisError(error);
    return {
      payload: { error: failure.message, code: failure.code },
      status: failure.status,
    };
  }
}

app.use("/checks", requireSignedInUser("the News Hub"));
app.use("/checks/*", requireSignedInUser("the News Hub"));

app.get("/checks/:id/timeline", async (context) => {
  const id = context.req.param("id");
  if (!isUuid(id)) return context.json({ error: "Check not found." }, 404);
  const user = await currentUser(context);
  if (!(await getCheckById(id, user?.id))) return context.json({ error: "Check not found." }, 404);
  return context.json({ timeline: await getTraceTimeline(id, user?.id) });
});
app.get("/checks/:id/appearances", async (context) => {
  const id = context.req.param("id");
  if (!isUuid(id)) return context.json({ error: "Check not found." }, 404);
  const user = await currentUser(context);
  if (!(await getCheckById(id, user?.id))) return context.json({ error: "Check not found." }, 404);
  return context.json({ appearances: await getTraceAppearances(id, user?.id) });
});
app.get("/checks", async (context) => {
  const page = positiveInteger(context.req.query("page"), 1, 10_000);
  const pageSize = positiveInteger(context.req.query("pageSize"), 20, 100);
  const query = (context.req.query("q") ?? "").slice(0, 200);

  try {
    const user = await currentUser(context);
    const result = await listChecks(page, pageSize, query, user?.id);
    return context.json({
      checks: result.checks,
      pagination: {
        page,
        pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / pageSize),
      },
    });
  } catch (error) {
    console.error("Could not list checks", error);
    return context.json(
      {
        error: error instanceof Error ? error.message : "Could not list checks.",
      },
      503,
    );
  }
});

app.get("/checks/:id", async (context) => {
  const id = context.req.param("id");
  if (!isUuid(id)) return context.json({ error: "Check not found." }, 404);

  try {
    const user = await currentUser(context);
    const check = await getCheckById(id, user?.id);
    if (!check) return context.json({ error: "Check not found." }, 404);
    const { rawInput: _rawInput, displayInput, ...checkDetails } = check;
    return context.json({
      check: { ...checkDetails, rawInput: displayInput },
    });
  } catch (error) {
    console.error("Could not retrieve check", error);
    return context.json(
      {
        error: error instanceof Error ? error.message : "Could not retrieve check.",
      },
      503,
    );
  }
});

/** Gate a route on a session, naming the screen the caller was trying to open. */
function requireSignedInUser(feature: string) {
  return async (context: Context<{ Bindings: Bindings }>, next: () => Promise<void>) => {
    if (!(await currentUser(context))) {
      return context.json({ error: `Sign in or create an account to open ${feature}.` }, 401);
    }
    await next();
  };
}

async function analyzeText(
  input: NormalizedInput,
  provider: AiProvider,
  auditLog: Array<{ stage: string; prompt: string }>,
  emit: ProgressEmitter = () => undefined,
  signal?: AbortSignal,
): Promise<{
  claims: ClaimVerdict[];
  claimEmbeddings: number[][];
  score: TraceraScore;
  framing: FramingAnalysis;
}> {
  const audit = {
    signal,
    onPrompt: (record: { stage: string; prompt: string }) => auditLog.push(record),
    onStructuredOutputAttempt: (record: {
      stage: string;
      attempt: number;
      valid: boolean;
      error?: string;
    }) =>
      auditLog.push({
        stage: "structured_output_attempt",
        prompt: JSON.stringify(record),
      }),
  };
  emit({
    stage: "claims",
    message: "Separating factual claims from framing and opinion.",
  });
  const [extractedClaims, framing] = await Promise.all([
    extractClaims(provider, input.text, audit),
    analyzeFraming(provider, input.text, audit),
  ]);
  if (extractedClaims.length === 0) {
    throw new AnalysisError("no_checkable_claims");
  }
  const claims: ClaimVerdict[] = [];
  const claimEmbeddings: number[][] = [];

  for (const [claimIndex, claim] of extractedClaims.entries()) {
    signal?.throwIfAborted();
    emit({
      stage: "retrieval",
      message: `Finding evidence for claim ${claimIndex + 1} of ${extractedClaims.length}.`,
      claimIndex,
      claimCount: extractedClaims.length,
    });
    const claimEmbedding = await provider.embed(claim.claimText, { signal });
    const sources = await retrieveSources(claim, {
      provider,
      signal,
      factCheckApiKey: process.env.GOOGLE_FACT_CHECK_API_KEY,
      corpusSimilarityThreshold: environmentNumber("CORPUS_SIMILARITY_THRESHOLD", 0.78, 0, 1),
      newsApiKey: process.env.NEWS_API_KEY,
      webSearchEndpoint: process.env.WEB_SEARCH_ENDPOINT,
      webSearchApiKey: process.env.WEB_SEARCH_API_KEY,
      claimEmbedding,
      storyContext: input.text,
      submittedSource: input.sourceUrl
        ? {
            id: `submitted-source:${claim.id}`,
            type: "submitted_source",
            title: input.title ?? input.sourceDomain ?? "Submitted source",
            url: input.sourceUrl,
            canonicalUrl: input.sourceUrl,
            sourceDomain: input.sourceDomain,
            snippet: input.text.slice(0, 3_000),
            publishedAt: input.publishedAt,
            publisherPublishedAt: input.publishedAt,
          }
        : undefined,
    });
    auditLog.push({
      stage: "retrieved_sources",
      prompt: JSON.stringify({
        claimId: claim.id,
        claimText: claim.claimText,
        sources,
      }),
    });
    const verdict = await scoreClaim(provider, claim, sources, audit);
    emit({
      stage: "verdict",
      message: `Scored claim ${claimIndex + 1} of ${extractedClaims.length}.`,
      claimIndex,
      claimCount: extractedClaims.length,
    });
    claims.push(verdict);
    claimEmbeddings.push(claimEmbedding);
  }

  return {
    claims,
    claimEmbeddings,
    score: aggregateScore(claims, framing),
    framing,
  };
}

function relatedContextCount(claims: ClaimVerdict[]) {
  return claims.reduce(
    (count, claim) =>
      count + claim.consideredSources.filter((source) => source.type === "corpus").length,
    0,
  );
}

function domainOutcomeSignals(claims: ClaimVerdict[]) {
  return claims.flatMap((claim) => {
    if (claim.confidence < 0.7 || claim.evidenceQuality < 0.65) return [];
    if (claim.verdict !== "supported" && claim.verdict !== "contradicted") return [];
    const weight = Number((claim.confidence * claim.evidenceQuality).toFixed(4));
    const positive =
      claim.verdict === "supported" ? claim.supportingSources : claim.contradictingSources;
    const negative =
      claim.verdict === "supported" ? claim.contradictingSources : claim.supportingSources;
    const seen = new Set<string>();
    return [
      ...positive.map((source) => ({ source, direction: "positive" as const })),
      ...negative.map((source) => ({ source, direction: "negative" as const })),
    ].flatMap(({ source, direction }) => {
      const domain = source.sourceDomain?.replace(/^www\./, "");
      if (!domain || seen.has(domain)) return [];
      seen.add(domain);
      return [
        {
          domain,
          direction,
          weight,
          claimId: claim.claim.id,
          verdict: claim.verdict,
        },
      ];
    });
  });
}

function hasRetrievedEvidence(claims: unknown[]) {
  return claims.some((claim) => {
    if (!claim || typeof claim !== "object") return false;
    const value = claim as {
      claim?: { claimText?: unknown };
      consideredSources?: unknown[];
      supportingSources?: unknown[];
      contradictingSources?: unknown[];
    };
    const claimText = typeof value.claim?.claimText === "string" ? value.claim.claimText : "";
    return [
      ...(value.consideredSources ?? []),
      ...(value.supportingSources ?? []),
      ...(value.contradictingSources ?? []),
    ].some((source) => cachedSourceIsRelevant(claimText, source));
  });
}

// Do not keep serving cached analyses produced before relevance filtering. This
// also makes a previously saved, obviously unrelated evidence set self-heal on
// the next submission of the same article.
function cachedSourceIsRelevant(claimText: string, source: unknown) {
  if (!claimText || !source || typeof source !== "object") return false;
  const value = source as {
    title?: unknown;
    claimText?: unknown;
    snippet?: unknown;
  };
  const sourceText = [value.title, value.claimText, value.snippet]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
  const claimTerms = cacheTerms(claimText);
  const sourceTerms = new Set(cacheTerms(sourceText));
  const overlap = claimTerms.filter((term) => sourceTerms.has(term)).length;
  const anchors = (claimText.match(/\b(?:[A-Z]{2,}|[A-Z][a-z]{2,})\b/g) ?? []).map((term) =>
    term.toLowerCase(),
  );
  return (
    overlap >= 2 && (anchors.length === 0 || anchors.some((anchor) => sourceTerms.has(anchor)))
  );
}

function cacheTerms(text: string) {
  const stopWords = new Set([
    "about",
    "after",
    "also",
    "amid",
    "been",
    "before",
    "being",
    "call",
    "could",
    "from",
    "government",
    "have",
    "into",
    "issue",
    "issues",
    "minister",
    "outcome",
    "outcomes",
    "over",
    "party",
    "political",
    "protest",
    "protests",
    "received",
    "recent",
    "said",
    "that",
    "their",
    "there",
    "these",
    "this",
    "those",
    "through",
    "under",
    "wake",
    "were",
    "where",
    "which",
    "with",
    "would",
  ]);
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 3 && !stopWords.has(term));
}

function configuredAiConfiguration(): AiProviderConfig {
  const apiKey = requiredEnvironment("AI_API_KEY");
  const provider = aiProviderName(process.env.AI_PROVIDER);
  const embeddingProvider = process.env.AI_EMBEDDING_PROVIDER
    ? aiProviderName(process.env.AI_EMBEDDING_PROVIDER)
    : undefined;
  const embeddingModel = optionalEnvironment("AI_EMBEDDING_MODEL");
  const embeddingDimensions = positiveInteger(process.env.AI_EMBEDDING_DIMENSIONS, 1024, 10_000);

  return {
    provider,
    apiKey,
    model: optionalEnvironment("AI_MODEL"),
    baseUrl: optionalEnvironment("AI_BASE_URL"),
    ...(embeddingProvider
      ? {
          embedding: {
            provider: embeddingProvider,
            apiKey: optionalEnvironment("AI_EMBEDDING_API_KEY") ?? apiKey,
            model: embeddingModel,
            baseUrl: optionalEnvironment("AI_EMBEDDING_BASE_URL"),
            dimensions: embeddingDimensions,
          },
        }
      : {
          embeddingModel,
          embeddingDimensions,
        }),
  };
}

function requiredEnvironment(name: string): string {
  const value = optionalEnvironment(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function aiProviderName(value: string | undefined): AiProviderName {
  const provider = value?.trim().toLowerCase();
  const supported: AiProviderName[] = [
    "anthropic",
    "gemini",
    "openai",
    "openrouter",
    "openai-compatible",
  ];
  if (!provider || !supported.includes(provider as AiProviderName)) {
    throw new Error(`AI_PROVIDER must be one of: ${supported.join(", ")}.`);
  }
  return provider as AiProviderName;
}

function requestBodyIsTooLarge(context: Context<{ Bindings: Bindings }>) {
  const contentLength = Number(context.req.header("content-length"));
  return Number.isFinite(contentLength) && contentLength > MAX_ANALYSIS_BODY_BYTES;
}

function publicAnalysisErrorFromPayload(payload: AnalysisErrorResponse) {
  const code = payload.code;
  return code === "no_checkable_claims"
    ? publicAnalysisError(new AnalysisError(code))
    : publicAnalysisError(undefined);
}

function analysisResponse(payload: AnalysisResponse) {
  return payload;
}

async function enforceFirstPartyAnalysisQuota(context: Context<{ Bindings: Bindings }>) {
  const user = await currentUser(context);
  if (!user) return null;
  const redis = upstashRedis(context.env);
  if (!redis) {
    return context.json({ error: "Analysis quotas are temporarily unavailable." }, 503);
  }

  const quota = await consumePublicApiQuota(redis, user.id, {
    minuteLimit: configuredPositiveInteger(
      context.env.ANALYSIS_RATE_LIMIT_PER_MINUTE ?? process.env.ANALYSIS_RATE_LIMIT_PER_MINUTE,
      5,
      1_000,
    ),
    dailyLimit: configuredPositiveInteger(
      context.env.ANALYSIS_DAILY_QUOTA ?? process.env.ANALYSIS_DAILY_QUOTA,
      100,
      100_000,
    ),
    keyPrefix: "tracera:first-party-analysis",
  }).catch((error): PublicAccessQuotaResult => {
    console.warn("First-party analysis quota check failed", error);
    return {
      allowed: false,
      status: 503,
      code: "quota_unavailable",
      message: "Analysis quotas are temporarily unavailable.",
    };
  });
  if (!quota.allowed) {
    if ("retryAfter" in quota) context.header("Retry-After", String(quota.retryAfter));
    return context.json({ error: quota.message }, quota.status);
  }
  context.header("RateLimit-Limit", String(quota.limit));
  context.header("RateLimit-Remaining", String(quota.remaining));
  context.header("RateLimit-Reset", String(quota.resetAt));
  return null;
}

async function normalizeWithStoredFallback(
  body: unknown,
  provider: AiProvider,
  signal?: AbortSignal,
) {
  const input =
    body && typeof body === "object"
      ? (body as {
          text?: string;
          url?: string;
          sourceUrl?: string;
          image?: string;
          imageMimeType?: string;
        })
      : {};
  try {
    return await normalizeInput(input, provider, { signal });
  } catch (error) {
    signal?.throwIfAborted();
    const candidate =
      input.url ??
      input.sourceUrl ??
      (typeof input.text === "string" && /^https?:\/\/\S+$/.test(input.text.trim())
        ? input.text.trim()
        : undefined);
    if (!candidate) throw error;
    const prior = await findLatestCheckByRawInput(candidate);
    const claimText = (prior?.claims ?? [])
      .flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const text = (item as { claim?: { claimText?: unknown } }).claim?.claimText;
        return typeof text === "string" && text.trim() ? [text.trim()] : [];
      })
      .join("\n");
    if (!claimText) throw error;
    const url = new URL(candidate);
    return {
      inputType: "link" as const,
      rawInput: candidate,
      text: claimText,
      sourceUrl: candidate,
      sourceDomain: url.hostname.replace(/^www\./, ""),
    };
  }
}

async function canRunAnalysis(context: Context<{ Bindings: Bindings }>, body: unknown) {
  return Boolean(body && (await currentUser(context)));
}

function requestedVisibility(
  body: unknown,
  userId: string | undefined,
  inherited?: "public" | "private",
): "public" | "private" {
  if (inherited) return inherited;
  const requested =
    body && typeof body === "object" && (body as { visibility?: unknown }).visibility === "private"
      ? "private"
      : "public";
  if (requested === "private" && !userId) {
    throw new Error("Sign in before saving a private trace.");
  }
  return requested;
}

function environmentNumber(name: string, fallback: number, minimum: number, maximum = Infinity) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

function environmentBoolean(rawValue: string | undefined, fallback: boolean) {
  const value = rawValue?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "true" || value === "1" || value === "yes";
}

function authorizedDomainTrustAdmin(context: Context<{ Bindings: Bindings }>) {
  const configured = context.env.DOMAIN_TRUST_ADMIN_TOKEN ?? process.env.DOMAIN_TRUST_ADMIN_TOKEN;
  return Boolean(configured && context.req.header("x-tracera-domain-admin-token") === configured);
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function currentUser(context: Context<{ Bindings: Bindings }>) {
  const request = context.req.raw;
  const cached = currentUserByRequest.get(request);
  if (cached) return cached;
  const user = authenticatedUser(request, {
    BETTER_AUTH_SECRET: context.env.BETTER_AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_API_KEY: context.env.BETTER_AUTH_API_KEY ?? process.env.BETTER_AUTH_API_KEY,
    BETTER_AUTH_API_URL: context.env.BETTER_AUTH_API_URL ?? process.env.BETTER_AUTH_API_URL,
    BETTER_AUTH_KV_URL: context.env.BETTER_AUTH_KV_URL ?? process.env.BETTER_AUTH_KV_URL,
    GOOGLE_CLIENT_ID: context.env.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: context.env.GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET,
  });
  currentUserByRequest.set(request, user);
  return user;
}
