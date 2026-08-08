import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  checkDatabase,
  findLatestCheckByRawInput,
  findRecentCheckByEmbedding,
  getCheckById,
  getTraceTimeline,
  listChecks,
  persistCheck,
  subscribeToCheck,
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
  getUserForSession,
  isValidEmail,
  isValidPassword,
  normalizeEmail,
  registerUser,
  revokeSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "./auth.js";

export const app = new Hono();
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
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
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
    setCookie(context, SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
    return context.json({ user }, 201);
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
    if (!user) return context.json({ error: "Invalid email or password." }, 401);
    const session = await createSession(user.id);
    setCookie(context, SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
    return context.json({ user });
  } catch (error) {
    console.error("Login failed", error);
    return context.json({ error: "Unable to sign you in." }, 503);
  }
});

app.post("/auth/logout", async (context) => {
  await revokeSession(getCookie(context, SESSION_COOKIE));
  deleteCookie(context, SESSION_COOKIE, sessionCookieOptions());
  return context.body(null, 204);
});

app.get("/auth/me", async (context) => {
  const user = await getUserForSession(getCookie(context, SESSION_COOKIE));
  return user
    ? context.json({ user })
    : context.json({ error: "Not authenticated." }, 401);
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

app.post("/analyze", async (context) => {
  const body = await context.req.json().catch(() => null);

  try {
    const requestSignal = context.req.raw.signal;
    const user = await getUserForSession(getCookie(context, SESSION_COOKIE));
    const provider = configuredProvider(requestSignal);
    const normalized = await normalizeWithStoredFallback(body, provider);
    const inputEmbedding = await provider.embed(normalized.text);
    const cached = await findRecentCheckByEmbedding(
      inputEmbedding,
      environmentNumber("DEDUP_SIMILARITY_THRESHOLD", 0.92, 0, 1),
      environmentNumber("DEDUP_MAX_AGE_HOURS", 24, 1),
    );

    // A previous version stored empty analyses when a URL was sent as text.
    // Never serve that invalid cache entry; rerun it with normalized link input.
    if (cached && hasRetrievedEvidence(cached.analysis.claims)) {
      return context.json({
        cached: true,
        dedupSimilarity: cached.similarity,
        check: { id: cached.id, createdAt: cached.createdAt },
        claims: cached.analysis.claims,
        traceraScore: cached.analysis.score,
      });
    }

    // User-triggered checks stay synchronous; scheduled rechecks run in the BullMQ worker.
    const result = await serializeAnalysis(
      () => analyzeText(normalized.text, provider),
      requestSignal,
    );
    const groundZero = traceGroundZero(
      result.claims.flatMap((claim) => [
        ...claim.supportingSources,
        ...claim.contradictingSources,
      ]),
    );
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
          stage: "claim_extraction",
          provider: process.env.AI_PROVIDER ?? "ollama",
          model: process.env.OLLAMA_MODEL ?? "gemma4:e2b",
        },
        { stage: "verdict_generation", count: result.claims.length },
      ],
      ownerUserId: user?.id,
    });

    return context.json(
      {
        cached: false,
        check: stored,
        claims: result.claims,
        traceraScore: result.score,
        groundZero,
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
  return context.json({ timeline: await getTraceTimeline(id) });
});
app.post("/checks/:id/alerts", async (context) => {
  const id = context.req.param("id");
  const body = await context.req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!isUuid(id) || !/^\S+@\S+\.\S+$/.test(email))
    return context.json(
      { error: "A valid check and email are required." },
      400,
    );
  return context.json({ subscription: await subscribeToCheck(id, email) }, 201);
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

  try {
    const result = await listChecks(page, pageSize);
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
    const check = await getCheckById(id);
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
): Promise<{
  claims: ClaimVerdict[];
  claimEmbeddings: number[][];
  score: TraceraScore;
}> {
  const extractedClaims = await extractClaims(provider, text);
  if (extractedClaims.length === 0) {
    throw new Error(
      "No checkable claims could be extracted. Please provide the article text or a public news link.",
    );
  }
  const claims: ClaimVerdict[] = [];
  const claimEmbeddings: number[][] = [];

  // Keep local model work serialized; this matches packages/ai's verifyText behavior.
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
    const verdict = await scoreClaim(provider, claim, sources);
    claims.push(verdict);
    claimEmbeddings.push(claimEmbedding);
  }

  return { claims, claimEmbeddings, score: aggregateScore(claims) };
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

function configuredProvider(signal?: AbortSignal) {
  const provider = process.env.AI_PROVIDER ?? "ollama";

  if (provider === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey)
      throw new Error("GEMINI_API_KEY is required when AI_PROVIDER=gemini.");
    return createAiProvider({
      provider: "gemini",
      apiKey,
      model: process.env.GEMINI_MODEL,
      embeddingModel: process.env.GEMINI_EMBEDDING_MODEL,
      embeddingDimensions: 1024,
    });
  }

  if (provider !== "ollama") {
    throw new Error(
      `Unsupported AI_PROVIDER: ${provider}. Use ollama or gemini.`,
    );
  }

  return createAiProvider({
    provider: "ollama",
    baseUrl: process.env.OLLAMA_BASE_URL,
    model: process.env.OLLAMA_MODEL,
    embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL,
    signal,
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

const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Tracera API listening on http://localhost:${port}`);
});
