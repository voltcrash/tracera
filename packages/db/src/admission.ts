import type {
  AnalysisAdmission,
  AnalysisControlLimits,
  AnalysisAdmissionRejection,
} from "./control-types.js";
import type { D1RepositoryOptions } from "./repository.js";
import { D1PayloadStore } from "./payloads.js";
import { utcPeriod } from "./clock.js";

interface AdmissionInput {
  userId: string;
  keySource?: "platform" | "user";
  ipHash: string;
  endpoint: string;
  idempotencyKey: string;
  requestHash: string;
  forceReanalysis: boolean;
  forceInputHash: string;
  limits: AnalysisControlLimits;
}
interface IdempotencyRow {
  request_hash: string;
  request_status: string;
  lease_id: string | null;
  response_body: string | null;
  response_blob_uri: string | null;
  response_hash: string | null;
  response_status: number | null;
  expires_at: number;
}
interface RateRow {
  scope_type: "user" | "ip";
  scope_key: string;
  request_count: number;
  window_started_at: number;
}
interface LeaseRow {
  id: string;
  user_id: string;
  ip_hash: string;
  expires_at: number;
}

export class D1AdmissionRepository {
  private readonly database: D1RepositoryOptions["database"];
  private readonly now: () => number;
  private readonly payloads: D1PayloadStore;
  constructor(options: D1RepositoryOptions) {
    this.database = options.database;
    this.now = options.now ?? Date.now;
    this.payloads = new D1PayloadStore(options.bucket);
  }

  async finishAnalysisAdmission(input: {
    userId: string;
    endpoint: string;
    idempotencyKey: string;
    leaseId: string;
    responseBody: unknown;
    responseStatus: number;
    idempotencyTtlSeconds: number;
  }): Promise<void> {
    if (!Number.isSafeInteger(input.idempotencyTtlSeconds) || input.idempotencyTtlSeconds <= 0)
      throw new RangeError("Idempotency expiry must be a positive integer.");
    if (
      !Number.isInteger(input.responseStatus) ||
      input.responseStatus < 100 ||
      input.responseStatus > 599
    )
      throw new RangeError("Response status must be an HTTP status code.");
    const now = this.now();
    const payload = await this.payloads.encode(input.responseBody, "responses");
    await this.database.batch([
      this.database
        .prepare(`UPDATE analysis_idempotency_keys SET request_status=?,response_body=?,response_blob_uri=?,response_hash=?,response_status=?,lease_id=NULL,expires_at=?,updated_at=?
        WHERE user_id=? AND endpoint=? AND idempotency_key=? AND lease_id=? AND request_status='in_progress'
        AND EXISTS(SELECT 1 FROM analysis_leases WHERE id=? AND user_id=? AND endpoint=? AND idempotency_key=? AND released_at IS NULL)`)
        .bind(
          input.responseStatus < 400 ? "completed" : "failed",
          payload.inline,
          payload.blobUri,
          payload.hash,
          input.responseStatus,
          now + input.idempotencyTtlSeconds * 1000,
          now,
          input.userId,
          input.endpoint,
          input.idempotencyKey,
          input.leaseId,
          input.leaseId,
          input.userId,
          input.endpoint,
          input.idempotencyKey,
        ),
      this.database
        .prepare(
          "UPDATE analysis_leases SET released_at=? WHERE id=? AND user_id=? AND endpoint=? AND idempotency_key=? AND released_at IS NULL",
        )
        .bind(now, input.leaseId, input.userId, input.endpoint, input.idempotencyKey),
    ]);
  }

  async beginAnalysisAdmission(input: AdmissionInput): Promise<AnalysisAdmission> {
    const now = this.now();
    const period = utcPeriod(now);
    const id = crypto.randomUUID();
    const limits = input.limits;
    const window = limits.rateWindowSeconds * 1000;
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError("Analysis limits must be non-negative integers.");
    if (!window || !limits.leaseSeconds || !limits.idempotencyTtlSeconds)
      throw new RangeError("Analysis expiry intervals must be positive.");
    const key = [input.userId, input.endpoint, input.idempotencyKey];
    const witness = "EXISTS(SELECT 1 FROM analysis_leases WHERE id=?)";
    const statements = [
      this.database
        .prepare(`INSERT INTO analysis_idempotency_keys(user_id,endpoint,idempotency_key,request_hash,request_status,lease_id,expires_at,created_at,updated_at)
        VALUES(?,?,?,?,'in_progress',?,?,?,?) ON CONFLICT(user_id,endpoint,idempotency_key) DO UPDATE SET request_hash=excluded.request_hash,request_status='in_progress',lease_id=excluded.lease_id,response_body=NULL,response_blob_uri=NULL,response_hash=NULL,response_status=NULL,expires_at=excluded.expires_at,updated_at=excluded.updated_at
        WHERE analysis_idempotency_keys.expires_at<=? OR (analysis_idempotency_keys.request_status='in_progress' AND analysis_idempotency_keys.request_hash=excluded.request_hash AND NOT EXISTS(SELECT 1 FROM analysis_leases WHERE id=analysis_idempotency_keys.lease_id AND released_at IS NULL AND expires_at>?))`)
        .bind(
          ...key,
          input.requestHash,
          id,
          now + limits.idempotencyTtlSeconds * 1000,
          now,
          now,
          now,
          now,
        ),
      this.database
        .prepare(`INSERT INTO analysis_leases(id,user_id,ip_hash,endpoint,idempotency_key,expires_at,created_at)
        SELECT ?,?,?,?,?,?,? FROM analysis_idempotency_keys WHERE user_id=? AND endpoint=? AND idempotency_key=? AND lease_id=?
        AND COALESCE((SELECT request_count FROM analysis_rate_limits WHERE scope_type='ip' AND scope_key=? AND window_started_at+?>?),0)<?
        AND COALESCE((SELECT request_count FROM analysis_rate_limits WHERE scope_type='user' AND scope_key=? AND window_started_at+?>?),0)<?
        AND (?=1 OR COALESCE((SELECT request_count FROM analysis_daily_quotas WHERE user_id=? AND period_start=?),0)<?)
        AND (SELECT count(*) FROM analysis_leases WHERE user_id=? AND released_at IS NULL AND expires_at>?)<?
        AND (SELECT count(*) FROM analysis_leases WHERE ip_hash=? AND released_at IS NULL AND expires_at>?)<?
        AND (?=0 OR COALESCE((SELECT cooldown_until FROM analysis_force_cooldowns WHERE user_id=? AND input_hash=?),0)<=?) RETURNING id`)
        .bind(
          id,
          input.userId,
          input.ipHash,
          input.endpoint,
          input.idempotencyKey,
          now + limits.leaseSeconds * 1000,
          now,
          ...key,
          id,
          input.ipHash,
          window,
          now,
          limits.ipRateLimit,
          input.userId,
          window,
          now,
          limits.userRateLimit,
          input.keySource === "user" ? 1 : 0,
          input.userId,
          period.periodStart,
          limits.dailyQuota,
          input.userId,
          now,
          limits.userConcurrencyLimit,
          input.ipHash,
          now,
          limits.ipConcurrencyLimit,
          input.forceReanalysis ? 1 : 0,
          input.userId,
          input.forceInputHash,
          now,
        ),
    ];
    for (const [type, key] of [
      ["user", input.userId],
      ["ip", input.ipHash],
    ])
      statements.push(
        this.database
          .prepare(`INSERT INTO analysis_rate_limits(scope_type,scope_key,window_started_at,request_count,updated_at)
      SELECT ?,?,?,1,? WHERE ${witness} ON CONFLICT(scope_type,scope_key) DO UPDATE SET window_started_at=CASE WHEN analysis_rate_limits.window_started_at+?<=? THEN excluded.window_started_at ELSE analysis_rate_limits.window_started_at END,
      request_count=CASE WHEN analysis_rate_limits.window_started_at+?<=? THEN 1 ELSE analysis_rate_limits.request_count+1 END,updated_at=excluded.updated_at`)
          .bind(type, key, now, now, id, window, now, window, now),
      );
    statements.push(
      this.database
        .prepare(
          `INSERT INTO analysis_daily_quotas(user_id,period_start,request_count) SELECT ?,?,1 WHERE ?=0 AND ${witness} ON CONFLICT(user_id,period_start) DO UPDATE SET request_count=request_count+1`,
        )
        .bind(input.userId, period.periodStart, input.keySource === "user" ? 1 : 0, id),
    );
    statements.push(
      this.database
        .prepare(
          `INSERT INTO analysis_force_cooldowns(user_id,input_hash,cooldown_until,updated_at) SELECT ?,?,?,? WHERE ?=1 AND ${witness} ON CONFLICT(user_id,input_hash) DO UPDATE SET cooldown_until=excluded.cooldown_until,updated_at=excluded.updated_at`,
        )
        .bind(
          input.userId,
          input.forceInputHash,
          now + limits.forceReanalysisCooldownSeconds * 1000,
          now,
          input.forceReanalysis ? 1 : 0,
          id,
        ),
    );
    statements.push(
      this.database
        .prepare(
          "SELECT * FROM analysis_idempotency_keys WHERE user_id=? AND endpoint=? AND idempotency_key=?",
        )
        .bind(...key),
    );
    statements.push(
      this.database
        .prepare(
          "SELECT * FROM analysis_rate_limits WHERE (scope_type='user' AND scope_key=?) OR (scope_type='ip' AND scope_key=?)",
        )
        .bind(input.userId, input.ipHash),
    );
    statements.push(
      this.database
        .prepare(
          "SELECT id,user_id,ip_hash,expires_at FROM analysis_leases WHERE released_at IS NULL AND expires_at>? AND (user_id=? OR ip_hash=?) ORDER BY expires_at",
        )
        .bind(now, input.userId, input.ipHash),
    );
    statements.push(
      this.database
        .prepare(
          "SELECT request_count FROM analysis_daily_quotas WHERE user_id=? AND period_start=?",
        )
        .bind(input.userId, period.periodStart),
    );
    statements.push(
      this.database
        .prepare(
          "SELECT cooldown_until FROM analysis_force_cooldowns WHERE user_id=? AND input_hash=?",
        )
        .bind(input.userId, input.forceInputHash),
    );
    statements.push(
      this.database
        .prepare(
          `DELETE FROM analysis_idempotency_keys WHERE user_id=? AND endpoint=? AND idempotency_key=? AND lease_id=? AND NOT ${witness}`,
        )
        .bind(...key, id, id),
    );
    const results = await this.database.batch<Record<string, unknown>>(statements);
    const idem = results[6]!.results[0] as unknown as IdempotencyRow;
    const rates = results[7]!.results as unknown as RateRow[];
    const leases = results[8]!.results as unknown as LeaseRow[];
    const rate = (type: "user" | "ip") => {
      const row = rates.find((row) => row.scope_type === type);
      const active = row && row.window_started_at + window > now;
      return {
        count: active ? row.request_count : 0,
        reset: active ? row.window_started_at + window : now + window,
      };
    };
    if (results[1]!.results.length) {
      const user = rate("user"),
        ip = rate("ip");
      return {
        kind: "admitted",
        leaseId: id,
        userRateLimit: {
          limit: limits.userRateLimit,
          remaining: Math.max(0, limits.userRateLimit - user.count),
          resetAt: new Date(user.reset).toISOString(),
        },
        ipRateLimit: {
          limit: limits.ipRateLimit,
          remaining: Math.max(0, limits.ipRateLimit - ip.count),
          resetAt: new Date(ip.reset).toISOString(),
        },
      };
    }
    const reject = (reason: AnalysisAdmissionRejection, at = now): AnalysisAdmission => ({
      kind: "rejected",
      reason,
      retryAt: new Date(at).toISOString(),
    });
    if (idem.request_hash !== input.requestHash && idem.expires_at > now)
      return reject("idempotency_conflict");
    if (idem.request_status !== "in_progress" && idem.expires_at > now)
      return {
        kind: "replay",
        responseBody: await this.payloads.read({
          inline: idem.response_body,
          blobUri: idem.response_blob_uri,
          hash: idem.response_hash ?? undefined,
        }),
        responseStatus: idem.response_status!,
      };
    if (idem.lease_id !== id) {
      const lease = leases.find((lease) => lease.id === idem.lease_id);
      if (lease) return reject("idempotency_in_progress", lease.expires_at);
    }
    if (rate("ip").count >= limits.ipRateLimit) return reject("ip_rate_limit", rate("ip").reset);
    if (rate("user").count >= limits.userRateLimit)
      return reject("user_rate_limit", rate("user").reset);
    const quota = Number(results[9]!.results[0]?.request_count ?? 0);
    if (input.keySource !== "user" && quota >= limits.dailyQuota)
      return reject("daily_quota", period.resetAt);
    const userLeases = leases.filter((lease) => lease.user_id === input.userId),
      ipLeases = leases.filter((lease) => lease.ip_hash === input.ipHash);
    if (userLeases.length >= limits.userConcurrencyLimit)
      return reject("user_concurrency_limit", userLeases[0]?.expires_at ?? now);
    if (ipLeases.length >= limits.ipConcurrencyLimit)
      return reject("ip_concurrency_limit", ipLeases[0]?.expires_at ?? now);
    const cooldown = Number(results[10]!.results[0]?.cooldown_until ?? 0);
    if (input.forceReanalysis && cooldown > now)
      return reject("force_reanalysis_cooldown", cooldown);
    throw new Error("Admission guards rejected an unclassified request.");
  }
}

export function createD1AdmissionRepository(options: D1RepositoryOptions): D1AdmissionRepository {
  return new D1AdmissionRepository(options);
}
