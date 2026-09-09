import { createHash } from "node:crypto";
import {
  InstrumentedAiProvider,
  type AiProvider,
  type AiProviderCall,
  type AiProviderConfig,
} from "@repo/ai";
import {
  beginAnalysisAdmission,
  reserveProviderSpend,
  settleProviderSpend,
  type AnalysisAdmission,
  type AnalysisAdmissionRejection,
  type AnalysisControlLimits,
} from "@repo/db";

const DEFAULTS = {
  userRateLimit: 30,
  ipRateLimit: 60,
  rateWindowSeconds: 3_600,
  userConcurrencyLimit: 2,
  ipConcurrencyLimit: 4,
  dailyQuota: 100,
  forceReanalysisCooldownSeconds: 3_600,
  leaseSeconds: 600,
  idempotencyTtlSeconds: 86_400,
  dailySpendUsd: 25,
  generationCostUsd: 0.01,
  imageCostUsd: 0.02,
  embeddingCostUsd: 0.0001,
} as const;

const CONTROL_MESSAGES = {
  user_rate_limited: "Your analysis rate limit has been reached. Please try again later.",
  ip_rate_limited: "This network has sent too many analyses. Please try again later.",
  user_concurrency_limited: "You already have the maximum number of analyses running.",
  ip_concurrency_limited: "This network already has the maximum number of analyses running.",
  daily_quota: "Your daily AI analysis quota has been reached. Please try again tomorrow.",
  force_reanalysis_cooldown:
    "This trace was reanalyzed recently. Please wait before forcing another reanalysis.",
  idempotency_conflict: "The idempotency key was already used for a different request.",
  idempotency_in_progress: "An analysis with this idempotency key is already in progress.",
  provider_spend_limit: "AI analysis is temporarily paused. Please try again later.",
  analysis_controls_unavailable: "Analysis is temporarily unavailable. Please try again later.",
} as const;

export type AnalysisControlCode = keyof typeof CONTROL_MESSAGES;

export type AnalysisControlEnvironment = Record<string, string | undefined>;

export interface AnalysisControlConfig extends AnalysisControlLimits {
  dailySpendUsd: number;
  generationCostUsd: number;
  imageCostUsd: number;
  embeddingCostUsd: number;
}

export class AnalysisControlError extends Error {
  constructor(
    readonly code: AnalysisControlCode,
    readonly retryAt?: string,
  ) {
    super(CONTROL_MESSAGES[code]);
    this.name = "AnalysisControlError";
  }
}

export function analysisControlConfig(env: AnalysisControlEnvironment): AnalysisControlConfig {
  return {
    userRateLimit: readInteger(env, "ANALYSIS_USER_RATE_LIMIT", DEFAULTS.userRateLimit),
    ipRateLimit: readInteger(env, "ANALYSIS_IP_RATE_LIMIT", DEFAULTS.ipRateLimit),
    rateWindowSeconds: readInteger(env, "ANALYSIS_RATE_WINDOW_SECONDS", DEFAULTS.rateWindowSeconds),
    userConcurrencyLimit: readInteger(
      env,
      "ANALYSIS_USER_CONCURRENCY_LIMIT",
      DEFAULTS.userConcurrencyLimit,
    ),
    ipConcurrencyLimit: readInteger(
      env,
      "ANALYSIS_IP_CONCURRENCY_LIMIT",
      DEFAULTS.ipConcurrencyLimit,
    ),
    dailyQuota: readInteger(env, "ANALYSIS_DAILY_QUOTA", DEFAULTS.dailyQuota),
    forceReanalysisCooldownSeconds: readInteger(
      env,
      "ANALYSIS_FORCE_REANALYSIS_COOLDOWN_SECONDS",
      DEFAULTS.forceReanalysisCooldownSeconds,
    ),
    leaseSeconds: readInteger(env, "ANALYSIS_LEASE_SECONDS", DEFAULTS.leaseSeconds),
    idempotencyTtlSeconds: readInteger(
      env,
      "ANALYSIS_IDEMPOTENCY_TTL_SECONDS",
      DEFAULTS.idempotencyTtlSeconds,
    ),
    dailySpendUsd: readMoney(env, "AI_DAILY_SPEND_LIMIT_USD", DEFAULTS.dailySpendUsd),
    generationCostUsd: readMoney(
      env,
      "AI_ESTIMATED_GENERATION_COST_USD",
      DEFAULTS.generationCostUsd,
    ),
    imageCostUsd: readMoney(env, "AI_ESTIMATED_IMAGE_COST_USD", DEFAULTS.imageCostUsd),
    embeddingCostUsd: readMoney(env, "AI_ESTIMATED_EMBEDDING_COST_USD", DEFAULTS.embeddingCostUsd),
  };
}

export function analysisRequestIdentity(
  request: Request,
  body: unknown,
  secret: string | undefined,
) {
  const ip = requestIp(request);
  const salt = secret?.trim() || "tracera-analysis-controls";
  return {
    ipHash: digest(`${salt}:ip:${ip}`),
    requestHash: digest(stableStringify(body)),
    forceInputHash: digest(stableStringify(analysisTarget(body))),
  };
}

export function readIdempotencyKey(
  request: Request,
): { valid: true; value: string } | { valid: false; message: string } {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) {
    return { valid: false, message: "The Idempotency-Key header is required." };
  }
  if (value.length > 255 || !/^[!-~]+$/.test(value)) {
    return {
      valid: false,
      message: "The Idempotency-Key header must be 1 to 255 printable ASCII characters.",
    };
  }
  return { valid: true, value };
}

export async function admitAnalysis(input: {
  userId: string;
  request: Request;
  endpoint: string;
  body: unknown;
  idempotencyKey: string;
  forceReanalysis: boolean;
  config: AnalysisControlConfig;
  secret?: string;
}): Promise<AnalysisAdmission> {
  const identity = analysisRequestIdentity(input.request, input.body, input.secret);
  try {
    return await beginAnalysisAdmission({
      userId: input.userId,
      ipHash: identity.ipHash,
      endpoint: input.endpoint,
      idempotencyKey: input.idempotencyKey,
      requestHash: identity.requestHash,
      forceReanalysis: input.forceReanalysis,
      forceInputHash: identity.forceInputHash,
      limits: input.config,
    });
  } catch (error) {
    console.error("Could not reserve analysis controls", error);
    throw new AnalysisControlError("analysis_controls_unavailable");
  }
}

export function analysisAdmissionError(
  admission: Extract<AnalysisAdmission, { kind: "rejected" }>,
) {
  const code = rejectionCode(admission.reason);
  return new AnalysisControlError(
    code,
    code === "idempotency_conflict" ? undefined : admission.retryAt,
  );
}

export function analysisControlPayload(error: AnalysisControlError) {
  const retryAfterSeconds = error.retryAt ? retryAfterSecondsFrom(error.retryAt) : undefined;
  return {
    error: error.message,
    code: error.code,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

export function analysisControlStatus(code: AnalysisControlCode): 409 | 429 | 503 {
  if (code === "idempotency_conflict" || code === "idempotency_in_progress") return 409;
  if (code === "provider_spend_limit" || code === "analysis_controls_unavailable") return 503;
  return 429;
}

export function analysisControlHeaders(error: AnalysisControlError) {
  const retryAfterSeconds = error.retryAt ? retryAfterSecondsFrom(error.retryAt) : undefined;
  const headers: Record<string, string> = {};
  if (retryAfterSeconds !== undefined) headers["retry-after"] = String(retryAfterSeconds);
  return headers;
}

export function analysisRateHeaders(admission: Extract<AnalysisAdmission, { kind: "admitted" }>) {
  const limit = Math.min(admission.userRateLimit.limit, admission.ipRateLimit.limit);
  const remaining = Math.min(admission.userRateLimit.remaining, admission.ipRateLimit.remaining);
  const resetAt = Math.max(
    Date.parse(admission.userRateLimit.resetAt),
    Date.parse(admission.ipRateLimit.resetAt),
  );
  return {
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(Math.ceil(resetAt / 1000)),
  };
}

export function spendLimitedAiProvider(
  provider: AiProvider,
  aiConfiguration: AiProviderConfig,
  config: AnalysisControlConfig,
) {
  return new InstrumentedAiProvider(provider, {
    onCall: async <T>(call: AiProviderCall, operation: () => Promise<T>) => {
      const providerKey =
        call.kind === "embed"
          ? (aiConfiguration.embedding?.provider ?? aiConfiguration.provider)
          : aiConfiguration.provider;
      const reservationResult = await reserveProviderSpendSafely({
        providerKey,
        estimatedUsd: estimatedCost(call, config),
        dailyBudgetUsd: config.dailySpendUsd,
      });
      if (!reservationResult.allowed) {
        throw new AnalysisControlError("provider_spend_limit", reservationResult.retryAt);
      }
      try {
        return await operation();
      } finally {
        await settleProviderSpend({
          reservationId: reservationResult.reservation.id,
          actualUsd: reservationResult.reservation.estimatedUsd,
        }).catch((error) => console.warn("Could not settle provider spend", error));
      }
    },
  });
}

function rejectionCode(reason: AnalysisAdmissionRejection): AnalysisControlCode {
  switch (reason) {
    case "user_rate_limit":
      return "user_rate_limited";
    case "ip_rate_limit":
      return "ip_rate_limited";
    case "user_concurrency_limit":
      return "user_concurrency_limited";
    case "ip_concurrency_limit":
      return "ip_concurrency_limited";
    case "daily_quota":
      return "daily_quota";
    case "force_reanalysis_cooldown":
      return "force_reanalysis_cooldown";
    case "idempotency_conflict":
      return "idempotency_conflict";
    case "idempotency_in_progress":
      return "idempotency_in_progress";
  }
}

async function reserveProviderSpendSafely(input: {
  providerKey: string;
  estimatedUsd: number;
  dailyBudgetUsd: number;
}) {
  try {
    return await reserveProviderSpend(input);
  } catch (error) {
    console.error("Could not reserve provider spend", error);
    throw new AnalysisControlError("analysis_controls_unavailable");
  }
}

function estimatedCost(call: AiProviderCall, config: AnalysisControlConfig) {
  const base =
    call.kind === "embed"
      ? config.embeddingCostUsd
      : call.kind === "generate_image"
        ? config.imageCostUsd
        : config.generationCostUsd;
  const retrySafetyFactor = call.kind === "generate" || call.kind === "generate_image" ? 2 : 1;
  return Number((base * retrySafetyFactor).toFixed(6));
}

function requestIp(request: Request) {
  const vercelForwarded = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const value = vercelForwarded || realIp || forwarded || "unknown";
  return value.length <= 255 ? value : value.slice(0, 255);
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function analysisTarget(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const body = value as Record<string, unknown>;
  return Object.fromEntries(
    ["text", "url", "image", "imageMimeType"].flatMap((key) =>
      body[key] === undefined ? [] : [[key, body[key]]],
    ),
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "null";
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function readInteger(env: AnalysisControlEnvironment, name: string, fallback: number) {
  const raw = env[name] ?? process.env[name];
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 1_000_000 ? value : fallback;
}

function readMoney(env: AnalysisControlEnvironment, name: string, fallback: number) {
  const raw = env[name] ?? process.env[name];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= 1_000_000 ? value : fallback;
}

function retryAfterSecondsFrom(retryAt: string) {
  const remaining = Date.parse(retryAt) - Date.now();
  return Math.max(1, Math.ceil(remaining / 1000));
}
