import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  applyEditorialDomainTrustReview,
  finishAnalysisAdmission,
  checkDatabase,
  configureDatabase,
  findGroundZeroCorpusHistory,
  findLatestCheckByRawInput,
  findRelatedStoryCheck,
  findReusableExactCheck,
  findReusableImageCheck,
  getCheckById,
  getDomainTrustHistory,
  getTraceAppearances,
  getTraceTimeline,
  listChecks,
  persistCheck,
  recordTraceAppearance,
  recordDomainOutcomeSignals,
  type AnalysisAdmission,
  EMBEDDING_DIMENSIONS,
} from "@repo/db";
import {
  aggregateScore,
  analyzeFraming,
  assertPublicHttpUrl,
  createAiProvider,
  extractClaims,
  retrieveSources,
  retrieveArchiveHistory,
  scoreClaim,
  normalizeInput,
  traceGroundZero,
  writeHeadline,
  type AiProvider,
  type AiProviderConfig,
  type AiProviderName,
  type ClaimVerdict,
  type EvidenceSource,
  type FramingAnalysis,
  type NormalizedInput,
  type TraceraScore,
} from "@repo/ai";
import type { AnalysisErrorResponse, AnalysisResponse } from "@repo/contracts";
import { authenticatedUser, type AuthBindings } from "./auth";
import { AnalysisError, publicAnalysisError } from "./analysis-errors";
import { apiRelativePath } from "./base-path";
import { allowedCorsOrigin } from "./cors-origin";
import {
  healthErrorResponse,
  internalErrorResponse,
  logServerWarning,
  requestIdForContext,
  requestIdMiddleware,
  serviceUnavailableResponse,
  logServerError,
  REQUEST_ID_HEADER,
} from "./error-handling";
import { reanalysisPolicy } from "./reanalysis-policy";
import { parseFirstPartyAnalysisInput } from "./analysis-input";
import {
  AnalysisControlError,
  admitAnalysis,
  analysisAdmissionError,
  analysisControlConfig,
  analysisControlHeaders,
  analysisControlPayload,
  analysisControlStatus,
  analysisRateHeaders,
  readIdempotencyKey,
  spendLimitedAiProvider,
  type AnalysisControlConfig,
} from "./analysis-controls";
import { requestedVisibility } from "./submission-visibility";

export type Bindings = AuthBindings & {
  DATABASE_URL?: string;
  [key: string]: string | undefined;
};

export const app = new Hono<{ Bindings: Bindings }>();
const currentUserByRequest = new WeakMap<Request, ReturnType<typeof authenticatedUser>>();

app.use("*", requestIdMiddleware);
app.onError((error, context) =>
  internalErrorResponse(context, error, "Unhandled Tracera API error"),
);

app.use("*", async (context, next) => {
  if (apiRelativePath(context.req.path) !== "/") {
    configureDatabase(context.env.DATABASE_URL);
  }
  await next();
});
app.use("/*", async (context, next) =>
  cors({
    origin: (origin) => allowedCorsOrigin(origin, context.req.url),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Idempotency-Key"],
    exposeHeaders: [
      "Retry-After",
      "X-Idempotency-Replayed",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      REQUEST_ID_HEADER,
    ],
    credentials: true,
  })(context, next),
);

app.get("/", (context) => context.json({ message: "Hello from Tracera API." }));

app.get("/auth/me", async (context) => {
  const user = await currentUser(context);
  return user ? context.json({ user }) : context.json({ error: "Not authenticated." }, 401);
});

app.get("/health", async (context) => {
  try {
    const database = await checkDatabase();

    return context.json({ status: "ok", services: { database } });
  } catch (error) {
    return healthErrorResponse(context, error);
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
type AdmittedAnalysis = Extract<AnalysisAdmission, { kind: "admitted" }>;
type AnalysisPreparation =
  | { kind: "response"; response: Response }
  | { kind: "replay"; admission: Extract<AnalysisAdmission, { kind: "replay" }> }
  | {
      kind: "admitted";
      admission: AdmittedAnalysis;
      userId: string;
      endpoint: string;
      idempotencyKey: string;
      config: AnalysisControlConfig;
    };
type ManagedAnalysisResult = {
  payload: AnalysisResponse | AnalysisErrorResponse | ReturnType<typeof analysisControlPayload>;
  status: 200 | 201 | 400 | 409 | 422 | 429 | 503;
};

const MAX_ANALYSIS_BODY_BYTES = 7_100_000;
const DEDUP_SAFETY_CAP_HOURS = 24;
const IMAGE_DEDUP_SIMILARITY = 0.98;
const RELATED_STORY_SIMILARITY = 0.84;
const RELATED_STORY_MAX_AGE_HOURS = 24 * 90;
const CORPUS_SIMILARITY = 0.78;

app.post("/analyze", async (context) => {
  const requestBody = await readAnalysisRequestBody(context);
  if (requestBody.tooLarge) {
    return context.json({ error: "Request body is too large." }, 413);
  }
  const parsed = parseFirstPartyAnalysisInput(requestBody.body);
  if (!parsed.success) return context.json({ error: parsed.error }, 400);
  const body = parsed.data;
  const prepared = await prepareAnalysis(context, body, "/analyze");
  if (prepared.kind === "response") return prepared.response;
  if (prepared.kind === "replay") {
    return context.json(
      prepared.admission.responseBody as Record<string, unknown>,
      prepared.admission.responseStatus as 200 | 201 | 422 | 503,
      { "x-idempotency-replayed": "true" },
    );
  }
  const result = await runManagedAnalysis(context, body, prepared);
  return context.json(result.payload, result.status, analysisRateHeaders(prepared.admission));
});

app.post("/analyze/stream", async (context) => {
  const requestBody = await readAnalysisRequestBody(context);
  if (requestBody.tooLarge) {
    return context.json({ error: "Request body is too large." }, 413);
  }
  const parsed = parseFirstPartyAnalysisInput(requestBody.body);
  if (!parsed.success) return context.json({ error: parsed.error }, 400);
  const body = parsed.data;
  const prepared = await prepareAnalysis(context, body, "/analyze/stream");
  if (prepared.kind === "response") return prepared.response;
  if (prepared.kind === "replay") {
    return replayedAnalysisStream(
      prepared.admission.responseBody,
      prepared.admission.responseStatus,
    );
  }
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
      void runManagedAnalysis(
        context,
        body,
        prepared,
        (progress) => emit("progress", progress),
        analysisSignal,
      )
        .then((result) => {
          if (analysisSignal.aborted) {
            cancelled = true;
            return;
          }
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
            requestId: requestIdForContext(context),
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
      ...analysisRateHeaders(prepared.admission),
    },
  });
});

async function prepareAnalysis(
  context: Context<{ Bindings: Bindings }>,
  body: unknown,
  endpoint: string,
): Promise<AnalysisPreparation> {
  const user = await currentUser(context);
  if (!user) {
    return {
      kind: "response",
      response: context.json({ error: "Sign in or create an account to start a fact-check." }, 401),
    };
  }
  const idempotency = readIdempotencyKey(context.req.raw);
  if (!idempotency.valid) {
    return {
      kind: "response",
      response: context.json({ error: idempotency.message, code: "idempotency_key_required" }, 400),
    };
  }
  const config = analysisControlConfig(context.env);
  try {
    const admission = await admitAnalysis({
      userId: user.id,
      request: context.req.raw,
      endpoint,
      body,
      idempotencyKey: idempotency.value,
      forceReanalysis:
        body !== null &&
        typeof body === "object" &&
        (body as { forceReanalysis?: unknown }).forceReanalysis === true,
      config,
      secret: context.env.BETTER_AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET,
    });
    if (admission.kind === "rejected") {
      return {
        kind: "response",
        response: controlResponse(context, analysisAdmissionError(admission)),
      };
    }
    if (admission.kind === "replay") return { kind: "replay", admission };
    return {
      kind: "admitted",
      admission,
      userId: user.id,
      endpoint,
      idempotencyKey: idempotency.value,
      config,
    };
  } catch (error) {
    const failure =
      error instanceof AnalysisControlError
        ? error
        : new AnalysisControlError("analysis_controls_unavailable");
    return { kind: "response", response: controlResponse(context, failure) };
  }
}

function controlResponse(context: Context<{ Bindings: Bindings }>, error: AnalysisControlError) {
  return context.json(
    analysisControlPayload(error),
    analysisControlStatus(error.code),
    analysisControlHeaders(error),
  );
}

async function runManagedAnalysis(
  context: Context<{ Bindings: Bindings }>,
  body: unknown,
  preparation: Extract<AnalysisPreparation, { kind: "admitted" }>,
  emit: ProgressEmitter = () => undefined,
  signal: AbortSignal = context.req.raw.signal,
): Promise<ManagedAnalysisResult> {
  let result: ManagedAnalysisResult;
  try {
    result = await runAnalysis(context, body, emit, signal, preparation.config);
  } catch (error) {
    if (error instanceof AnalysisControlError) {
      result = {
        payload: analysisControlPayload(error),
        status: analysisControlStatus(error.code),
      };
    } else {
      const failure = publicAnalysisError(error);
      result = {
        payload: { error: failure.message, code: failure.code },
        status: failure.status,
      };
    }
  }
  try {
    await finishAnalysisAdmission({
      userId: preparation.userId,
      endpoint: preparation.endpoint,
      idempotencyKey: preparation.idempotencyKey,
      leaseId: preparation.admission.leaseId,
      responseBody: result.payload,
      responseStatus: result.status,
      idempotencyTtlSeconds: preparation.config.idempotencyTtlSeconds,
    });
  } catch (error) {
    console.error("Could not finalize analysis controls", error);
  }
  return result;
}

function replayedAnalysisStream(payload: unknown, status: number) {
  const encoder = new TextEncoder();
  const event = status < 400 ? "complete" : "error";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-idempotency-replayed": "true",
    },
  });
}

async function runAnalysis(
  context: Context<{ Bindings: Bindings }>,
  body: unknown,
  emit: ProgressEmitter = () => undefined,
  signal: AbortSignal = context.req.raw.signal,
  controlConfig: AnalysisControlConfig = analysisControlConfig(context.env),
): Promise<
  | { payload: AnalysisResponse; status: 200 | 201 }
  | { payload: AnalysisErrorResponse; status: 400 | 422 | 503 }
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
    const provider = spendLimitedAiProvider(
      createAiProvider(aiConfiguration),
      aiConfiguration,
      controlConfig,
    );
    const normalized = await normalizeWithStoredFallback(body, provider, signal, user?.id);
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
    const cacheHours = Math.min(initialPolicy.dedupHours, DEDUP_SAFETY_CAP_HOURS);
    const cached = forceReanalysis
      ? null
      : normalized.inputType === "image"
        ? await findReusableImageCheck(
            normalized.rawInput,
            inputEmbedding,
            cacheHours,
            IMAGE_DEDUP_SIMILARITY,
            user?.id,
            visibility,
          )
        : await findReusableExactCheck(normalized.rawInput, cacheHours, user?.id, visibility);

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
          headline: cached.headline ?? undefined,
          claims: cached.analysis.claims as ClaimVerdict[],
          traceraScore: cached.analysis.score as TraceraScore,
        }),
      };
    }

    const auditLog: Array<{ stage: string; prompt: string }> = [];
    const result = await analyzeText(normalized, provider, auditLog, emit, signal, user?.id);
    signal.throwIfAborted();
    const submittedSource: EvidenceSource[] =
      normalized.sourceUrl && normalized.publishedAt
        ? [
            {
              id: "submitted-source",
              type: "submitted_source",
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
      visibility,
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
      RELATED_STORY_SIMILARITY,
      RELATED_STORY_MAX_AGE_HOURS,
      visibility,
      user?.id,
    );
    const completedPolicy = reanalysisPolicy({
      inputType: normalized.inputType,
      publishedAt: normalized.publishedAt,
    });
    const stored = await persistCheck({
      rawInput: normalized.rawInput,
      headline: result.headline,
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
      publishConsent: hasPublicationConsent(body),
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
    }).catch((error) =>
      logServerWarning("Could not record domain outcome signals", error, context.req.raw),
    );

    emit({
      stage: "persisted",
      message: "The completed evidence trail was saved.",
    });
    return {
      status: 201,
      payload: analysisResponse({
        cached: false,
        check: stored,
        headline: result.headline,
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
    if (error instanceof AnalysisControlError) throw error;
    if (signal.aborted) throw signal.reason ?? error;
    const failure = publicAnalysisError(error);
    const requestId = requestIdForContext(context);
    if (failure.code === "analysis_unavailable") {
      logServerError("Analysis failed", error, context.req.raw);
    }
    return {
      payload: { error: failure.message, code: failure.code, requestId },
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
  const ownedOnly = context.req.query("scope") === "mine";

  try {
    const user = await currentUser(context);
    const result = await listChecks(page, pageSize, query, user?.id, ownedOnly);
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
    return serviceUnavailableResponse(
      context,
      error,
      "Could not list checks.",
      "Could not list checks",
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
    return serviceUnavailableResponse(
      context,
      error,
      "Could not retrieve check.",
      "Could not retrieve check",
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
  ownerUserId?: string,
): Promise<{
  claims: ClaimVerdict[];
  claimEmbeddings: number[][];
  score: TraceraScore;
  framing: FramingAnalysis;
  headline: string;
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
  const [extractedClaims, framing, headline] = await Promise.all([
    extractClaims(provider, input.text, audit),
    analyzeFraming(provider, input.text, audit),
    writeHeadline(provider, input, audit),
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
      ownerUserId,
      factCheckApiKey: process.env.GOOGLE_FACT_CHECK_API_KEY,
      corpusSimilarityThreshold: CORPUS_SIMILARITY,
      newsApiKey: process.env.NEWS_API_KEY,
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
    headline,
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
            dimensions: EMBEDDING_DIMENSIONS,
          },
        }
      : {
          embeddingModel,
          embeddingDimensions: EMBEDDING_DIMENSIONS,
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

async function readAnalysisRequestBody(
  context: Context<{ Bindings: Bindings }>,
): Promise<{ tooLarge: true } | { tooLarge: false; body: unknown }> {
  if (requestBodyIsTooLarge(context)) return { tooLarge: true };

  const stream = context.req.raw.body;
  if (!stream) return { tooLarge: false, body: null };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_ANALYSIS_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { tooLarge: true };
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { tooLarge: false, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { tooLarge: false, body: null };
  } finally {
    reader.releaseLock();
  }
}

function analysisResponse(payload: AnalysisResponse) {
  return payload;
}

async function normalizeWithStoredFallback(
  body: unknown,
  provider: AiProvider,
  signal?: AbortSignal,
  ownerUserId?: string,
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
    await assertPublicHttpUrl(candidate);
    const prior = await findLatestCheckByRawInput(candidate, ownerUserId);
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

function hasPublicationConsent(body: unknown) {
  return Boolean(
    body &&
    typeof body === "object" &&
    (body as { publishConsent?: unknown }).publishConsent === true,
  );
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
    GOOGLE_CLIENT_ID: context.env.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: context.env.GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET,
    GITHUB_CLIENT_ID: context.env.GITHUB_CLIENT_ID ?? process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: context.env.GITHUB_CLIENT_SECRET ?? process.env.GITHUB_CLIENT_SECRET,
  });
  currentUserByRequest.set(request, user);
  return user;
}
