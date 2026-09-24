import { assertEnvironmentConfiguration } from "@repo/environment";
import {
  createDatabasePool,
  createUnconfiguredDatabase,
  type DatabaseClient as PoolClient,
} from "@repo/db/connection";

export {
  createDatabasePool,
  databaseTransportFor,
  type DatabaseClient,
  type DatabasePool,
  type DatabaseTransport,
} from "@repo/db/connection";

export const EMBEDDING_DIMENSIONS = 1024;

if (process.env.DATABASE_URL) assertEnvironmentConfiguration(process.env, "runtime");
let activeConnectionString = process.env.DATABASE_URL;
let active = activeConnectionString
  ? createDatabasePool(activeConnectionString, process.env)
  : createUnconfiguredDatabase();

/** Configure from the validated environment before handling a request. */
export let pool = active.pool;
export let db = active.db;

export function configureDatabase(
  connectionString: string | undefined,
  environment: Record<string, string | undefined> = process.env,
) {
  if (!connectionString) {
    throw new Error("DATABASE_URL must be configured for the Tracera server.");
  }
  const selected = { ...environment, DATABASE_URL: connectionString };
  assertEnvironmentConfiguration(selected, "runtime");
  assertRuntimeDatabaseRole(connectionString);
  if (connectionString === activeConnectionString) return;
  const previous = active.pool;
  activeConnectionString = connectionString;
  active = createDatabasePool(connectionString, selected);
  pool = active.pool;
  db = active.db;
  void previous.end().catch(() => undefined);
}

export function activeDatabaseTransport() {
  return active.transport;
}

/** Closes the active pool; later queries fail until the database is configured again. */
export async function closeDatabase() {
  const previous = active.pool;
  activeConnectionString = undefined;
  active = createUnconfiguredDatabase();
  pool = active.pool;
  db = active.db;
  await previous.end();
}

export function assertRuntimeDatabaseRole(
  connectionString: string,
  environment = process.env.NODE_ENV,
) {
  if (environment !== "production") return;

  let username: string;
  try {
    username = decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection string.");
  }
  if (username !== "tracera_runtime") {
    throw new Error("Production DATABASE_URL must use the tracera_runtime role.");
  }
}

export interface AuthUser {
  id: string;
  email: string;
  createdAt: string;
}

/** A prior, sufficiently evidenced claim that can be used as supplementary RAG context. */
export async function checkDatabase() {
  const result = await pool.query<{ connected: number }>("SELECT 1 AS connected");

  return result.rows[0]?.connected === 1 ? "connected" : "unavailable";
}

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

/** Atomically admits one analysis across all server instances sharing Postgres. */
export async function beginAnalysisAdmission(input: {
  userId: string;
  ipHash: string;
  endpoint: string;
  idempotencyKey: string;
  requestHash: string;
  forceReanalysis: boolean;
  forceInputHash: string;
  limits: AnalysisControlLimits;
}): Promise<AnalysisAdmission> {
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const clock = await client.query<{ now: string; next_day: string }>(
      "SELECT NOW()::text AS now, ((((NOW() AT TIME ZONE 'UTC')::date + 1)::timestamp) AT TIME ZONE 'UTC')::text AS next_day",
    );
    const now = new Date(clock.rows[0]?.now ?? Date.now());
    const nextDay = clock.rows[0]?.next_day ?? new Date(now.getTime() + 86_400_000).toISOString();

    const idempotency = await getOrCreateIdempotencyKey(client, input, now);
    if (idempotency.kind !== "new") {
      if (idempotency.kind === "conflict") {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return {
          kind: "rejected",
          reason: "idempotency_conflict",
          retryAt: now.toISOString(),
        };
      }
      if (idempotency.kind === "replay") {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return idempotency;
      }
      if (idempotency.active) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return {
          kind: "rejected",
          reason: "idempotency_in_progress",
          retryAt: idempotency.retryAt,
        };
      }
    }

    const ipScope = { type: "ip" as const, key: input.ipHash, limit: input.limits.ipRateLimit };
    const userScope = {
      type: "user" as const,
      key: input.userId,
      limit: input.limits.userRateLimit,
    };
    const scopes = [ipScope, userScope].sort((left, right) =>
      `${left.type}:${left.key}`.localeCompare(`${right.type}:${right.key}`),
    );
    const firstScope = scopes[0];
    const secondScope = scopes[1];
    if (!firstScope || !secondScope) throw new Error("Analysis scopes were not created.");
    for (const scope of scopes) {
      await client.query(
        `INSERT INTO analysis_rate_limits
           (scope_type, scope_key, window_started_at, request_count)
         VALUES ($1, $2, NOW(), 0)
         ON CONFLICT (scope_type, scope_key) DO NOTHING`,
        [scope.type, scope.key],
      );
    }

    const rateRows = await client.query<{
      scope_type: "user" | "ip";
      scope_key: string;
      window_started_at: string;
      request_count: number;
    }>(
      `SELECT scope_type, scope_key, window_started_at, request_count
         FROM analysis_rate_limits
        WHERE (scope_type = $1 AND scope_key = $2)
           OR (scope_type = $3 AND scope_key = $4)
        ORDER BY scope_type, scope_key
        FOR UPDATE`,
      [firstScope.type, firstScope.key, secondScope.type, secondScope.key],
    );
    const rateStates = new Map<string, AnalysisRateLimitState>();
    const rateCounts = new Map<string, number>();
    for (const row of rateRows.rows) {
      const configuredLimit = row.scope_type === "user" ? userScope.limit : ipScope.limit;
      const startedAt = new Date(row.window_started_at);
      const resetAt = new Date(startedAt.getTime() + input.limits.rateWindowSeconds * 1000);
      const expired = resetAt.getTime() <= now.getTime();
      const count = expired ? 0 : Number(row.request_count);
      if (expired) {
        await client.query(
          `UPDATE analysis_rate_limits
              SET window_started_at = NOW(), request_count = 0, updated_at = NOW()
            WHERE scope_type = $1 AND scope_key = $2`,
          [row.scope_type, row.scope_key],
        );
      }
      if (count >= configuredLimit) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return {
          kind: "rejected",
          reason: row.scope_type === "user" ? "user_rate_limit" : "ip_rate_limit",
          retryAt: expired
            ? new Date(now.getTime() + input.limits.rateWindowSeconds * 1000).toISOString()
            : resetAt.toISOString(),
        };
      }
      const key = `${row.scope_type}:${row.scope_key}`;
      rateCounts.set(key, count + 1);
      rateStates.set(key, {
        limit: configuredLimit,
        remaining: Math.max(0, configuredLimit - count - 1),
        resetAt: (expired
          ? new Date(now.getTime() + input.limits.rateWindowSeconds * 1000)
          : resetAt
        ).toISOString(),
      });
    }

    await client.query(
      `INSERT INTO analysis_daily_quotas (user_id, period_start, request_count)
       VALUES ($1, (NOW() AT TIME ZONE 'UTC')::date, 0)
       ON CONFLICT (user_id, period_start) DO NOTHING`,
      [input.userId],
    );
    const quota = await client.query<{ request_count: number }>(
      `SELECT request_count
         FROM analysis_daily_quotas
        WHERE user_id = $1 AND period_start = (NOW() AT TIME ZONE 'UTC')::date
        FOR UPDATE`,
      [input.userId],
    );
    const dailyCount = Number(quota.rows[0]?.request_count ?? 0);
    if (dailyCount >= input.limits.dailyQuota) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return { kind: "rejected", reason: "daily_quota", retryAt: nextDay };
    }

    const activeLeases = await client.query<{
      id: string;
      user_id: string;
      ip_hash: string;
      expires_at: string;
    }>(
      `SELECT id, user_id, ip_hash, expires_at
         FROM analysis_leases
        WHERE released_at IS NULL
          AND expires_at > $3::timestamptz
          AND (user_id = $1 OR ip_hash = $2)
        ORDER BY expires_at
        FOR UPDATE`,
      [input.userId, input.ipHash, now.toISOString()],
    );
    const activeForUser = activeLeases.rows.filter((row) => row.user_id === input.userId).length;
    const activeForIp = activeLeases.rows.filter((row) => row.ip_hash === input.ipHash).length;
    if (activeForUser >= input.limits.userConcurrencyLimit) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return {
        kind: "rejected",
        reason: "user_concurrency_limit",
        retryAt: earliestLeaseExpiry(activeLeases.rows, input.userId, now),
      };
    }
    if (activeForIp >= input.limits.ipConcurrencyLimit) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return {
        kind: "rejected",
        reason: "ip_concurrency_limit",
        retryAt: earliestLeaseExpiry(activeLeases.rows, input.ipHash, now, true),
      };
    }

    if (input.forceReanalysis) {
      await client.query(
        `INSERT INTO analysis_force_cooldowns (user_id, input_hash, cooldown_until)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id, input_hash) DO NOTHING`,
        [input.userId, input.forceInputHash],
      );
      const cooldown = await client.query<{ cooldown_until: string }>(
        `SELECT cooldown_until
           FROM analysis_force_cooldowns
          WHERE user_id = $1 AND input_hash = $2
          FOR UPDATE`,
        [input.userId, input.forceInputHash],
      );
      const cooldownUntil = new Date(cooldown.rows[0]?.cooldown_until ?? now);
      if (cooldownUntil.getTime() > now.getTime()) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return {
          kind: "rejected",
          reason: "force_reanalysis_cooldown",
          retryAt: cooldownUntil.toISOString(),
        };
      }
      await client.query(
        `UPDATE analysis_force_cooldowns
            SET cooldown_until = NOW() + ($3 * INTERVAL '1 second'), updated_at = NOW()
          WHERE user_id = $1 AND input_hash = $2`,
        [input.userId, input.forceInputHash, input.limits.forceReanalysisCooldownSeconds],
      );
    }

    const lease = await client.query<{ id: string; expires_at: string }>(
      `INSERT INTO analysis_leases
         (user_id, ip_hash, endpoint, idempotency_key, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 * INTERVAL '1 second'))
       RETURNING id, expires_at`,
      [input.userId, input.ipHash, input.endpoint, input.idempotencyKey, input.limits.leaseSeconds],
    );
    const leaseRow = lease.rows[0];
    if (!leaseRow) throw new Error("Analysis lease insert returned no row.");

    for (const scope of scopes) {
      const key = `${scope.type}:${scope.key}`;
      await client.query(
        `UPDATE analysis_rate_limits
            SET request_count = $3, updated_at = NOW()
          WHERE scope_type = $1 AND scope_key = $2`,
        [scope.type, scope.key, rateCounts.get(key) ?? 1],
      );
    }
    await client.query(
      `UPDATE analysis_daily_quotas
          SET request_count = request_count + 1
        WHERE user_id = $1 AND period_start = (NOW() AT TIME ZONE 'UTC')::date`,
      [input.userId],
    );
    await updateIdempotencyLease(client, input, leaseRow.id);
    await client.query("COMMIT");
    transactionOpen = false;

    const userRateLimit = rateStates.get(`user:${input.userId}`);
    const ipRateLimit = rateStates.get(`ip:${input.ipHash}`);
    if (!userRateLimit || !ipRateLimit)
      throw new Error("Analysis rate limit state was not created.");
    return { kind: "admitted", leaseId: leaseRow.id, userRateLimit, ipRateLimit };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release(true);
  }
}

export async function finishAnalysisAdmission(input: {
  userId: string;
  endpoint: string;
  idempotencyKey: string;
  leaseId: string;
  responseBody: unknown;
  responseStatus: number;
  idempotencyTtlSeconds: number;
}) {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      `UPDATE analysis_leases
          SET released_at = NOW()
        WHERE id = $1 AND user_id = $2 AND released_at IS NULL`,
      [input.leaseId, input.userId],
    );
    await client.query(
      `UPDATE analysis_idempotency_keys
          SET request_status = $4,
              response_body = $5::jsonb,
              response_status = $6,
              lease_id = NULL,
              expires_at = NOW() + ($7 * INTERVAL '1 second'),
              updated_at = NOW()
        WHERE user_id = $1 AND endpoint = $2 AND idempotency_key = $3`,
      [
        input.userId,
        input.endpoint,
        input.idempotencyKey,
        input.responseStatus < 400 ? "completed" : "failed",
        JSON.stringify(input.responseBody),
        input.responseStatus,
        input.idempotencyTtlSeconds,
      ],
    );
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release(true);
  }
}

export type ProviderSpendReservation = {
  id: string;
  providerKey: string;
  estimatedUsd: number;
  resetAt: string;
};

export type ProviderSpendAdmission =
  | { allowed: true; reservation: ProviderSpendReservation }
  | { allowed: false; retryAt: string };

/** Reserves estimated provider spend with a row lock, making the breaker global. */
export async function reserveProviderSpend(input: {
  providerKey: string;
  estimatedUsd: number;
  dailyBudgetUsd: number;
  reservationId?: string;
}): Promise<ProviderSpendAdmission> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const clock = await client.query<{ now: string; period_start: string; reset_at: string }>(
      `SELECT NOW()::text AS now,
              (NOW() AT TIME ZONE 'UTC')::date::text AS period_start,
              (((((NOW() AT TIME ZONE 'UTC')::date + 1)::timestamp) AT TIME ZONE 'UTC'))::text AS reset_at`,
    );
    const current = clock.rows[0];
    if (!current) throw new Error("Provider spend clock returned no row.");
    if (input.reservationId) {
      const existing = await client.query<{
        provider_key: string;
        estimated_usd: string;
      }>(
        `SELECT provider_key, estimated_usd
           FROM ai_spend_reservations WHERE id = $1 FOR UPDATE`,
        [input.reservationId],
      );
      const row = existing.rows[0];
      if (row) {
        // A retry may cross the UTC day boundary; the charge stays in its original period.
        if (
          row.provider_key !== input.providerKey ||
          Number(row.estimated_usd) !== input.estimatedUsd
        ) {
          throw new Error("Spend reservation identity was reused with different immutable input.");
        }
        await client.query("COMMIT");
        transactionOpen = false;
        return {
          allowed: true,
          reservation: {
            id: input.reservationId,
            providerKey: input.providerKey,
            estimatedUsd: input.estimatedUsd,
            resetAt: new Date(current.reset_at).toISOString(),
          },
        };
      }
    }
    await client.query(
      `INSERT INTO ai_provider_spend
         (provider_key, period_start, budget_usd, reserved_usd, actual_usd)
       VALUES ($1, $2::date, $3, 0, 0)
       ON CONFLICT (provider_key, period_start)
       DO UPDATE SET budget_usd = EXCLUDED.budget_usd, updated_at = NOW()`,
      [input.providerKey, current.period_start, input.dailyBudgetUsd],
    );
    const state = await client.query<{
      budget_usd: string;
      reserved_usd: string;
      actual_usd: string;
      open_until: string | null;
    }>(
      `SELECT budget_usd, reserved_usd, actual_usd, open_until
         FROM ai_provider_spend
        WHERE provider_key = $1 AND period_start = $2::date
        FOR UPDATE`,
      [input.providerKey, current.period_start],
    );
    const row = state.rows[0];
    if (!row) throw new Error("Provider spend state was not created.");
    const now = new Date(current.now).getTime();
    if (row.open_until && new Date(row.open_until).getTime() > now) {
      await client.query("COMMIT");
      transactionOpen = false;
      return { allowed: false, retryAt: new Date(row.open_until).toISOString() };
    }
    const committed = Number(row.reserved_usd) + Number(row.actual_usd);
    if (input.estimatedUsd <= 0 || committed + input.estimatedUsd > Number(row.budget_usd)) {
      await client.query(
        `UPDATE ai_provider_spend
            SET open_until = ($2::date + 1)::timestamp AT TIME ZONE 'UTC', updated_at = NOW()
          WHERE provider_key = $1 AND period_start = $2::date`,
        [input.providerKey, current.period_start],
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return { allowed: false, retryAt: new Date(current.reset_at).toISOString() };
    }
    const reservation = await client.query<{ id: string }>(
      `INSERT INTO ai_spend_reservations
         (id, provider_key, period_start, estimated_usd)
       VALUES (COALESCE($4::uuid, gen_random_uuid()), $1, $2::date, $3)
       RETURNING id`,
      [input.providerKey, current.period_start, input.estimatedUsd, input.reservationId ?? null],
    );
    const reservationRow = reservation.rows[0];
    if (!reservationRow) throw new Error("Provider spend reservation returned no row.");
    await client.query(
      `UPDATE ai_provider_spend
          SET reserved_usd = reserved_usd + $3, updated_at = NOW()
        WHERE provider_key = $1 AND period_start = $2::date`,
      [input.providerKey, current.period_start, input.estimatedUsd],
    );
    await client.query("COMMIT");
    transactionOpen = false;
    return {
      allowed: true,
      reservation: {
        id: reservationRow.id,
        providerKey: input.providerKey,
        estimatedUsd: input.estimatedUsd,
        resetAt: new Date(current.reset_at).toISOString(),
      },
    };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release(true);
  }
}

/** Settles a spend reservation. Unknown provider usage is charged at estimate. */
export async function settleProviderSpend(input: { reservationId: string; actualUsd: number }) {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const reservation = await client.query<{
      provider_key: string;
      period_start: string;
      estimated_usd: string;
      settled_at: string | null;
    }>(
      `SELECT provider_key, period_start, estimated_usd, settled_at
         FROM ai_spend_reservations
        WHERE id = $1
        FOR UPDATE`,
      [input.reservationId],
    );
    const row = reservation.rows[0];
    if (!row || row.settled_at) {
      await client.query("COMMIT");
      transactionOpen = false;
      return;
    }
    const actualUsd =
      Number.isFinite(input.actualUsd) && input.actualUsd >= 0
        ? input.actualUsd
        : Number(row.estimated_usd);
    const clock = await client.query<{ reset_at: string }>(
      `SELECT ((($1::date + 1)::timestamp) AT TIME ZONE 'UTC')::text AS reset_at`,
      [row.period_start],
    );
    const resetAt = clock.rows[0]?.reset_at;
    if (!resetAt) throw new Error("Provider spend reset time was not created.");
    await client.query(
      `UPDATE ai_provider_spend
          SET reserved_usd = GREATEST(0, reserved_usd - $3),
              actual_usd = actual_usd + $4,
              open_until = CASE
                WHEN actual_usd + $4 >= budget_usd
                  THEN COALESCE(open_until, $5::timestamptz)
                ELSE open_until
              END,
              updated_at = NOW()
        WHERE provider_key = $1 AND period_start = $2::date`,
      [row.provider_key, row.period_start, row.estimated_usd, actualUsd, resetAt],
    );
    await client.query(
      `UPDATE ai_spend_reservations
          SET actual_usd = $2, settled_at = NOW()
        WHERE id = $1`,
      [input.reservationId, actualUsd],
    );
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release(true);
  }
}

async function getOrCreateIdempotencyKey(
  client: PoolClient,
  input: {
    userId: string;
    endpoint: string;
    idempotencyKey: string;
    requestHash: string;
    limits: AnalysisControlLimits;
  },
  now: Date,
) {
  const inserted = await client.query(
    `INSERT INTO analysis_idempotency_keys
       (user_id, endpoint, idempotency_key, request_hash, request_status, expires_at)
     VALUES ($1, $2, $3, $4, 'in_progress', NOW() + ($5 * INTERVAL '1 second'))
     ON CONFLICT (user_id, endpoint, idempotency_key) DO NOTHING`,
    [
      input.userId,
      input.endpoint,
      input.idempotencyKey,
      input.requestHash,
      input.limits.idempotencyTtlSeconds,
    ],
  );
  if (inserted.rowCount === 1) return { kind: "new" as const };
  const result = await client.query<{
    request_hash: string;
    request_status: "in_progress" | "completed" | "failed";
    response_body: unknown;
    response_status: number | null;
    expires_at: string;
    lease_id: string | null;
  }>(
    `SELECT request_hash, request_status, response_body, response_status,
            expires_at, lease_id
       FROM analysis_idempotency_keys
      WHERE user_id = $1 AND endpoint = $2 AND idempotency_key = $3
      FOR UPDATE`,
    [input.userId, input.endpoint, input.idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Idempotency record was not created.");
  if (
    row.request_hash !== input.requestHash &&
    new Date(row.expires_at).getTime() > now.getTime()
  ) {
    return { kind: "conflict" as const };
  }
  if (row.request_status !== "in_progress" && new Date(row.expires_at).getTime() > now.getTime()) {
    if (row.response_body === null || row.response_status === null) {
      throw new Error("Completed idempotency record has no response.");
    }
    return {
      kind: "replay" as const,
      responseBody: row.response_body,
      responseStatus: row.response_status,
    };
  }
  if (row.request_status === "in_progress" && row.lease_id) {
    const lease = await client.query<{ expires_at: string; released_at: string | null }>(
      `SELECT expires_at, released_at FROM analysis_leases WHERE id = $1`,
      [row.lease_id],
    );
    const leaseRow = lease.rows[0];
    if (
      leaseRow &&
      !leaseRow.released_at &&
      new Date(leaseRow.expires_at).getTime() > now.getTime()
    ) {
      return { kind: "existing" as const, active: true, retryAt: leaseRow.expires_at };
    }
  }
  return { kind: "existing" as const, active: false, retryAt: now.toISOString() };
}

async function updateIdempotencyLease(
  client: PoolClient,
  input: {
    userId: string;
    endpoint: string;
    idempotencyKey: string;
    requestHash: string;
    limits: AnalysisControlLimits;
  },
  leaseId: string,
) {
  await client.query(
    `UPDATE analysis_idempotency_keys
        SET request_hash = $4, request_status = 'in_progress',
            response_body = NULL, response_status = NULL, lease_id = $5,
            expires_at = NOW() + ($6 * INTERVAL '1 second'), updated_at = NOW()
      WHERE user_id = $1 AND endpoint = $2 AND idempotency_key = $3`,
    [
      input.userId,
      input.endpoint,
      input.idempotencyKey,
      input.requestHash,
      leaseId,
      input.limits.idempotencyTtlSeconds,
    ],
  );
}

function earliestLeaseExpiry(
  rows: Array<{ user_id: string; ip_hash: string; expires_at: string }>,
  key: string,
  now: Date,
  ip = false,
) {
  const matching = rows.filter((row) => (ip ? row.ip_hash === key : row.user_id === key));
  return matching[0]?.expires_at ?? new Date(now.getTime() + 60_000).toISOString();
}
