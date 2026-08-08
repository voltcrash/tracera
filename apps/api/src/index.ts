import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  alertSubscriptionForCheck,
  deleteAuthSessionById,
  findUserByEmail,
  checkDatabase,
  findGroundZeroCorpusHistory,
  findLatestCheckByRawInput,
  findReusableExactCheck,
  getCheckById,
  getDecayObservability,
  getMediaDietPreference,
  getTraceTimeline,
  listChecks,
  listAuthSessions,
  mediaDietReport,
  optedInMediaDietRecipients,
  persistCheck,
  subscribeToCheck,
  setMediaDietPreference,
  unsubscribeFromCheck,
} from "@repo/db";
import {
  aggregateScore,
  createAiProvider,
  extractClaims,
  retrieveSources,
  scoreClaim,
  normalizeInput,
  traceGroundZero,
  type AiProvider,
  type ClaimVerdict,
  type TraceraScore,
} from "@repo/ai";
import { createClient } from "redis";
import {
  authenticateUser,
  createSession,
  createAccountActionToken,
  consumeAccountActionToken,
  getUserForSession,
  isValidEmail,
  isValidPassword,
  normalizeEmail,
  hashPassword,
  markEmailVerified,
  registerUser,
  revokeSession,
  SESSION_COOKIE,
  sessionCookieOptions,
  updateUserPassword,
} from "./auth.js";

export const app = new Hono();
const rateLimitHits = new Map<string, { count: number; resetAt: number }>();
app.use("/auth/*", async (context, next) => {
  const key = `${context.req.path}:${context.req.header("x-forwarded-for") ?? "local"}`;
  const now = Date.now();
  const hit = rateLimitHits.get(key);
  const current =
    !hit || hit.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : hit;
  current.count += 1;
  rateLimitHits.set(key, current);
  if (current.count > 12)
    return context.json(
      { error: "Too many attempts. Please try again shortly." },
      429,
    );
  await next();
});
app.use(
  "/*",
  cors({
    // The browser extension has a unique chrome-extension:// origin on every
    // install. Reflect only that origin (and the configured web app) so its
    // side panel can call the local API without opening CORS to arbitrary sites.
    origin: (origin) => {
      const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
      return origin === webOrigin || origin.startsWith("chrome-extension://")
        ? origin
        : undefined;
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Tracera-Mobile"],
    credentials: true,
  }),
);
const redis = createClient({
  url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
});
let analysisQueue: Promise<void> = Promise.resolve();

async function checkRedis() {
  if (!redis.isOpen) {
    await redis.connect();
  }

  return redis.ping();
}

app.get("/", (context) => context.json({ message: "Hello from Tracera API." }));

app.post("/auth/signup", async (context) => {
  const body = await context.req.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  const password = body?.password;
  if (!isValidEmail(email)) {
    return context.json({ error: "Enter a valid email address." }, 400);
  }
  if (!isValidPassword(password)) {
    return context.json(
      { error: "Password must be between 8 and 128 characters." },
      400,
    );
  }

  try {
    const user = await registerUser(email, password);
    if (!user) {
      return context.json(
        { error: "An account with this email already exists." },
        409,
      );
    }
    const session = await createSession(user.id);
    void sendAccountAction(user.id, user.email, "verify_email").catch((error) =>
      console.warn("Could not send verification email", error),
    );
    setCookie(
      context,
      SESSION_COOKIE,
      session.token,
      sessionCookieOptions(session.expiresAt),
    );
    return context.json(sessionResponse(context, user, session), 201);
  } catch (error) {
    console.error("Sign-up failed", error);
    return context.json({ error: "Unable to create your account." }, 503);
  }
});

app.post("/auth/login", async (context) => {
  const body = await context.req.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  const password = body?.password;
  if (!isValidEmail(email) || typeof password !== "string") {
    return context.json({ error: "Invalid email or password." }, 400);
  }

  try {
    const user = await authenticateUser(email, password);
    if (!user)
      return context.json({ error: "Invalid email or password." }, 401);
    const session = await createSession(user.id);
    setCookie(
      context,
      SESSION_COOKIE,
      session.token,
      sessionCookieOptions(session.expiresAt),
    );
    return context.json(sessionResponse(context, user, session));
  } catch (error) {
    console.error("Login failed", error);
    return context.json({ error: "Unable to sign you in." }, 503);
  }
});

app.post("/auth/logout", async (context) => {
  await revokeSession(sessionToken(context));
  deleteCookie(context, SESSION_COOKIE, sessionCookieOptions());
  return context.body(null, 204);
});

app.get("/auth/me", async (context) => {
  const user = await getUserForSession(sessionToken(context));
  return user
    ? context.json({ user })
    : context.json({ error: "Not authenticated." }, 401);
});

app.post("/auth/request-verification", async (context) => {
  const user = await getUserForSession(sessionToken(context));
  if (!user) return context.json({ error: "Not authenticated." }, 401);
  await sendAccountAction(user.id, user.email, "verify_email");
  return context.body(null, 204);
});
app.post("/auth/verify-email", async (context) => {
  const body = await context.req.json().catch(() => null);
  if (typeof body?.token !== "string")
    return context.json({ error: "A verification token is required." }, 400);
  const userId = await consumeAccountActionToken(body.token, "verify_email");
  if (!userId)
    return context.json(
      { error: "This verification link is invalid or expired." },
      400,
    );
  await markEmailVerified(userId);
  return context.body(null, 204);
});
app.post("/auth/forgot-password", async (context) => {
  const body = await context.req.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (isValidEmail(email)) {
    const user = await findUserByEmail(email);
    if (user) await sendAccountAction(user.id, user.email, "reset_password");
  }
  return context.body(null, 204);
});
app.post("/auth/reset-password", async (context) => {
  const body = await context.req.json().catch(() => null);
  if (typeof body?.token !== "string" || !isValidPassword(body?.password))
    return context.json(
      { error: "A valid reset token and password are required." },
      400,
    );
  const userId = await consumeAccountActionToken(body.token, "reset_password");
  if (!userId)
    return context.json(
      { error: "This reset link is invalid or expired." },
      400,
    );
  await updateUserPassword(userId, await hashPassword(body.password));
  return context.body(null, 204);
});
app.get("/auth/sessions", async (context) => {
  const user = await getUserForSession(sessionToken(context));
  return user
    ? context.json({ sessions: await listAuthSessions(user.id) })
    : context.json({ error: "Not authenticated." }, 401);
});
app.delete("/auth/sessions/:id", async (context) => {
  const user = await getUserForSession(sessionToken(context));
  if (!user) return context.json({ error: "Not authenticated." }, 401);
  await deleteAuthSessionById(user.id, context.req.param("id"));
  return context.body(null, 204);
});
app.get("/reports/media-diet", async (context) => {
  const user = await getUserForSession(sessionToken(context));
  if (!user) return context.json({ error: "Not authenticated." }, 401);
  return context.json({
    report: await mediaDietReport(user.id),
    preference: await getMediaDietPreference(user.id),
  });
});
app.put("/reports/media-diet/preferences", async (context) => {
  const user = await getUserForSession(sessionToken(context));
  const body = await context.req.json().catch(() => null);
  if (!user) return context.json({ error: "Not authenticated." }, 401);
  const frequency = body?.frequency === "weekly" ? "weekly" : "monthly";
  await setMediaDietPreference(user.id, Boolean(body?.enabled), frequency);
  return context.json({ preference: await getMediaDietPreference(user.id) });
});
app.post("/internal/reports/media-diet/deliver", async (context) => {
  if (
    !process.env.INTERNAL_WORKER_TOKEN ||
    context.req.header("x-tracera-worker-token") !==
      process.env.INTERNAL_WORKER_TOKEN
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
      const report = await mediaDietReport(
        recipient.id,
        recipient.frequency === "weekly" ? 7 : 30,
      );
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
      if (!response.ok)
        throw new Error(
          `Media-diet delivery failed with HTTP ${response.status}.`,
        );
    }),
  );
  return context.json({ delivered: recipients.length });
});

app.get("/health", async (context) => {
  try {
    const [database, cache] = await Promise.all([
      checkDatabase(),
      checkRedis(),
    ]);

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

app.get("/internal/decay/observability", async (context) => {
  const token = process.env.INTERNAL_WORKER_TOKEN;
  if (!token || context.req.header("x-tracera-worker-token") !== token) {
    return context.json({ error: "Unauthorized" }, 401);
  }
  return context.json({
    events: await getDecayObservability(
      positiveInteger(context.req.query("limit"), 100, 500),
    ),
  });
});

app.post("/analyze", async (context) => {
  const body = await context.req.json().catch(() => null);

  try {
    const recheckOf = authorizedRecheckId(context, body);
    const requestSignal = context.req.raw.signal;
    const user = await getUserForSession(sessionToken(context));
    const parentCheck = recheckOf
      ? await getCheckById(recheckOf, undefined, true)
      : null;
    if (recheckOf && !parentCheck)
      throw new Error("Recheck target was not found.");
    const visibility = requestedVisibility(
      body,
      user?.id,
      parentCheck?.visibility,
    );
    const provider = configuredProvider();
    const normalized = await normalizeWithStoredFallback(body, provider);
    const inputEmbedding = await provider.embed(normalized.text);
    const forceReanalysis = Boolean(
      body &&
      typeof body === "object" &&
      (body as { forceReanalysis?: unknown }).forceReanalysis,
    );
    const cacheHours = environmentNumber("DEDUP_MAX_AGE_HOURS", 24, 1, 24 * 30);
    const cached =
      forceReanalysis || recheckOf
        ? null
        : await findReusableExactCheck(
            normalized.rawInput,
            cacheHours,
            user?.id,
          );

    // A previous version stored empty analyses when a URL was sent as text.
    // Never serve that invalid cache entry; rerun it with normalized link input.
    if (cached && hasRetrievedEvidence(cached.analysis.claims)) {
      return context.json({
        cached: true,
        reuse: {
          state: "reused_exact",
          expiresAt: cached.expiresAt,
          policy:
            "This is an identical recent submission. Similar stories are analyzed again and only prior verified claims are used as context.",
        },
        check: { id: cached.id, createdAt: cached.createdAt },
        claims: cached.analysis.claims,
        traceraScore: cached.analysis.score,
      });
    }

    // User-triggered checks stay synchronous; scheduled rechecks run in the BullMQ worker.
    const auditLog: Array<{ stage: string; prompt: string }> = [];
    const result = await serializeAnalysis(
      () => analyzeText(normalized.text, provider, auditLog),
      requestSignal,
    );
    const groundZeroSources = result.claims.flatMap((claim) => [
      ...claim.supportingSources,
      ...claim.contradictingSources,
    ]);
    const groundZeroHistory = await findGroundZeroCorpusHistory(
      [
        normalized.sourceUrl,
        ...groundZeroSources.map((source) => source.canonicalUrl ?? source.url),
      ].filter((url): url is string => Boolean(url)),
      user?.id,
    );
    const groundZero = traceGroundZero(groundZeroSources, groundZeroHistory);
    const stored = await persistCheck({
      rawInput: normalized.rawInput,
      inputType: normalized.inputType,
      sourceUrl: normalized.sourceUrl,
      sourceDomain: normalized.sourceDomain,
      publishedAt: normalized.publishedAt,
      inputEmbedding,
      traceraScore: result.score,
      analysis: { claims: result.claims, score: result.score },
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
          provider: "gemini",
          model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
        },
        ...auditLog,
      ],
      ownerUserId: parentCheck?.ownerUserId ?? user?.id,
      visibility,
      supersedesCheckId: recheckOf ?? undefined,
    });

    return context.json(
      {
        cached: false,
        check: stored,
        claims: result.claims,
        traceraScore: result.score,
        groundZero,
        inputMetadata: normalized.imageMetadata,
        reuse: {
          state: forceReanalysis
            ? "reanalyzed"
            : recheckOf
              ? "scheduled_recheck"
              : "fresh",
          relatedContextClaims: relatedContextCount(result.claims),
        },
      },
      201,
    );
  } catch (error) {
    console.error("Analysis failed", error);
    const message = error instanceof Error ? error.message : "Analysis failed.";
    return context.json(
      { error: message },
      message.startsWith("No checkable claims could be extracted") ? 422 : 503,
    );
  }
});

app.get("/checks/:id/timeline", async (context) => {
  const id = context.req.param("id");
  if (!isUuid(id)) return context.json({ error: "Check not found." }, 404);
  const user = await getUserForSession(sessionToken(context));
  if (!(await getCheckById(id, user?.id)))
    return context.json({ error: "Check not found." }, 404);
  return context.json({ timeline: await getTraceTimeline(id) });
});
app.post("/checks/:id/alerts", async (context) => {
  const id = context.req.param("id");
  const body = await context.req.json().catch(() => null);
  const user = await getUserForSession(sessionToken(context));
  const email =
    user?.email ?? (typeof body?.email === "string" ? body.email.trim() : "");
  if (!isUuid(id) || !isValidEmail(email))
    return context.json(
      { error: "A valid check and email are required." },
      400,
    );
  if (!(await getCheckById(id, user?.id)))
    return context.json({ error: "Check not found." }, 404);
  return context.json({ subscription: await subscribeToCheck(id, email) }, 201);
});
app.get("/checks/:id/alerts", async (context) => {
  const user = await getUserForSession(sessionToken(context));
  const id = context.req.param("id");
  if (!user || !isUuid(id))
    return context.json({ error: "Not authenticated." }, 401);
  return context.json({
    subscription: await alertSubscriptionForCheck(id, user.email),
  });
});
app.delete("/checks/:id/alerts", async (context) => {
  const id = context.req.param("id");
  const body = await context.req.json().catch(() => null);
  const user = await getUserForSession(sessionToken(context));
  const requestedEmail =
    typeof body?.email === "string" ? body.email.trim() : "";
  const email = user?.email ?? requestedEmail;
  if (!isUuid(id) || !isValidEmail(email))
    return context.json(
      { error: "A valid check and email are required." },
      400,
    );
  if (user && requestedEmail && normalizeEmail(requestedEmail) !== user.email)
    return context.json({ error: "You can only manage your own alerts." }, 403);
  if (!(await getCheckById(id, user?.id)))
    return context.json({ error: "Check not found." }, 404);
  await unsubscribeFromCheck(id, email);
  return context.body(null, 204);
});
app.get("/v1/checks/:id", async (context) => {
  if (
    process.env.PUBLIC_API_KEY &&
    context.req.header("x-api-key") !== process.env.PUBLIC_API_KEY
  )
    return context.json({ error: "Unauthorized" }, 401);
  const check = await getCheckById(context.req.param("id"));
  return check
    ? context.json({ check })
    : context.json({ error: "Not found" }, 404);
});

app.get("/checks", async (context) => {
  const page = positiveInteger(context.req.query("page"), 1, 10_000);
  const pageSize = positiveInteger(context.req.query("pageSize"), 20, 100);
  const query = (context.req.query("q") ?? "").slice(0, 200);

  try {
    const user = await getUserForSession(sessionToken(context));
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
        error:
          error instanceof Error ? error.message : "Could not list checks.",
      },
      503,
    );
  }
});

app.get("/checks/:id", async (context) => {
  const id = context.req.param("id");
  if (!isUuid(id)) return context.json({ error: "Check not found." }, 404);

  try {
    const user = await getUserForSession(sessionToken(context));
    const check = await getCheckById(id, user?.id);
    if (!check) return context.json({ error: "Check not found." }, 404);
    return context.json({ check });
  } catch (error) {
    console.error("Could not retrieve check", error);
    return context.json(
      {
        error:
          error instanceof Error ? error.message : "Could not retrieve check.",
      },
      503,
    );
  }
});

async function analyzeText(
  text: string,
  provider: AiProvider,
  auditLog: Array<{ stage: string; prompt: string }>,
): Promise<{
  claims: ClaimVerdict[];
  claimEmbeddings: number[][];
  score: TraceraScore;
}> {
  const audit = {
    onPrompt: (record: { stage: string; prompt: string }) =>
      auditLog.push(record),
  };
  const extractedClaims = await extractClaims(provider, text, audit);
  if (extractedClaims.length === 0) {
    throw new Error(
      "No checkable claims could be extracted. Please provide the article text or a public news link.",
    );
  }
  const claims: ClaimVerdict[] = [];
  const claimEmbeddings: number[][] = [];

  for (const claim of extractedClaims) {
    const claimEmbedding = await provider.embed(claim.claimText);
    const sources = await retrieveSources(claim, {
      provider,
      factCheckApiKey: process.env.GOOGLE_FACT_CHECK_API_KEY,
      corpusSimilarityThreshold: environmentNumber(
        "CORPUS_SIMILARITY_THRESHOLD",
        0.78,
        0,
        1,
      ),
      newsApiKey: process.env.NEWS_API_KEY,
      webSearchEndpoint: process.env.WEB_SEARCH_ENDPOINT,
      webSearchApiKey: process.env.WEB_SEARCH_API_KEY,
      claimEmbedding,
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
    claims.push(verdict);
    claimEmbeddings.push(claimEmbedding);
  }

  return { claims, claimEmbeddings, score: aggregateScore(claims) };
}

function relatedContextCount(claims: ClaimVerdict[]) {
  return claims.reduce(
    (count, claim) =>
      count +
      claim.consideredSources.filter((source) => source.type === "corpus")
        .length,
    0,
  );
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
    const claimText =
      typeof value.claim?.claimText === "string" ? value.claim.claimText : "";
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
  const anchors = (
    claimText.match(/\b(?:[A-Z]{2,}|[A-Z][a-z]{2,})\b/g) ?? []
  ).map((term) => term.toLowerCase());
  return (
    overlap >= 2 &&
    (anchors.length === 0 || anchors.some((anchor) => sourceTerms.has(anchor)))
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

function configuredProvider() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is required.");
  return createAiProvider({
    provider: "gemini",
    apiKey,
    model: process.env.GEMINI_MODEL,
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL,
    embeddingDimensions: 1024,
  });
}

function serializeAnalysis<T>(
  run: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const result = analysisQueue.then(() => {
    if (signal.aborted)
      throw signal.reason ?? new Error("Analysis request was cancelled.");
    return run();
  });
  analysisQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function normalizeWithStoredFallback(
  body: unknown,
  provider: AiProvider,
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
    return await normalizeInput(input, provider);
  } catch (error) {
    const candidate =
      input.url ??
      input.sourceUrl ??
      (typeof input.text === "string" &&
      /^https?:\/\/\S+$/.test(input.text.trim())
        ? input.text.trim()
        : undefined);
    if (!candidate) throw error;
    const prior = await findLatestCheckByRawInput(candidate);
    const claimText = (prior?.claims ?? [])
      .flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const text = (item as { claim?: { claimText?: unknown } }).claim
          ?.claimText;
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

/** Scheduled rechecks are the only callers allowed to bypass input deduplication. */
function authorizedRecheckId(context: Context, body: unknown) {
  const recheckOf =
    body &&
    typeof body === "object" &&
    typeof (body as { recheckOf?: unknown }).recheckOf === "string"
      ? (body as { recheckOf: string }).recheckOf
      : undefined;
  if (!recheckOf) return null;

  const token = process.env.INTERNAL_WORKER_TOKEN;
  if (!token || context.req.header("x-tracera-worker-token") !== token) {
    throw new Error("Unauthorized recheck request.");
  }
  if (!isUuid(recheckOf)) throw new Error("Invalid recheck target.");
  return recheckOf;
}

function requestedVisibility(
  body: unknown,
  userId: string | undefined,
  inherited?: "public" | "private",
): "public" | "private" {
  if (inherited) return inherited;
  const requested =
    body &&
    typeof body === "object" &&
    (body as { visibility?: unknown }).visibility === "private"
      ? "private"
      : "public";
  if (requested === "private" && !userId) {
    throw new Error("Sign in before saving a private trace.");
  }
  return requested;
}

function environmentNumber(
  name: string,
  fallback: number,
  minimum: number,
  maximum = Infinity,
) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum
    ? parsed
    : fallback;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function sessionToken(context: Context) {
  const authorization = context.req.header("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer ?? getCookie(context, SESSION_COOKIE);
}

function sessionResponse(
  context: Context,
  user: { id: string; email: string; createdAt: string },
  session: { token: string },
) {
  return context.req.header("x-tracera-mobile") === "1"
    ? { user, sessionToken: session.token }
    : { user };
}

async function sendAccountAction(
  userId: string,
  email: string,
  kind: "verify_email" | "reset_password",
) {
  const token = await createAccountActionToken(userId, kind);
  const route = kind === "verify_email" ? "verify-email" : "reset-password";
  const link = `${(process.env.PUBLIC_WEB_URL ?? "http://localhost:3000").replace(/\/$/, "")}/${route}?token=${encodeURIComponent(token)}`;
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_FROM_EMAIL;
  if (!apiKey || !from) {
    console.info(`${kind} link generated for ${email}: ${link}`);
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject:
        kind === "verify_email"
          ? "Verify your Tracera email"
          : "Reset your Tracera password",
      text: `Use this link within one hour: ${link}`,
    }),
  });
  if (!response.ok)
    throw new Error(
      `Account email delivery failed with HTTP ${response.status}.`,
    );
}

const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Tracera API listening on http://localhost:${port}`);
});
