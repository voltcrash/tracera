export type AnalysisAdmissionRejection =
  | "user_rate_limit"
  | "ip_rate_limit"
  | "user_concurrency_limit"
  | "ip_concurrency_limit"
  | "daily_quota"
  | "force_reanalysis_cooldown"
  | "idempotency_conflict"
  | "idempotency_in_progress";

export interface AnalysisControlLimits {
  userRateLimit: number;
  ipRateLimit: number;
  rateWindowSeconds: number;
  userConcurrencyLimit: number;
  ipConcurrencyLimit: number;
  dailyQuota: number;
  forceReanalysisCooldownSeconds: number;
  leaseSeconds: number;
  idempotencyTtlSeconds: number;
}

export interface AnalysisRateLimitState {
  limit: number;
  remaining: number;
  resetAt: string;
}

export type AnalysisAdmission =
  | {
      kind: "admitted";
      leaseId: string;
      userRateLimit: AnalysisRateLimitState;
      ipRateLimit: AnalysisRateLimitState;
    }
  | {
      kind: "replay";
      responseBody: unknown;
      responseStatus: number;
    }
  | {
      kind: "rejected";
      reason: AnalysisAdmissionRejection;
      retryAt: string;
    };
