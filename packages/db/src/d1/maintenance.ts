import type { D1RepositoryOptions } from "./repository.js";

export function createD1MaintenanceRepository(options: D1RepositoryOptions) {
  return {
    async purgeExpired(input: { rateWindowSeconds: number }) {
      if (!Number.isSafeInteger(input.rateWindowSeconds) || input.rateWindowSeconds <= 0)
        throw new RangeError("The rate window must be positive.");
      const now = (options.now ?? Date.now)();
      const database = options.database;
      const results = await database.batch([
        // Interrupted provider calls retain their estimate as actual spend; expiry never refunds them.
        database
          .prepare(`WITH expired AS (
          SELECT provider_key,key_source,period_start,SUM(estimated_micros) AS amount FROM ai_spend_reservations
          WHERE settled_at IS NULL AND expires_at<=? GROUP BY provider_key,key_source,period_start
        ) UPDATE ai_provider_spend AS spend SET
          reserved_micros=MAX(0,spend.reserved_micros-expired.amount),actual_micros=spend.actual_micros+expired.amount,
          open_until=CASE WHEN spend.actual_micros+expired.amount>=spend.budget_micros
            THEN COALESCE(spend.open_until,unixepoch(spend.period_start,'+1 day')*1000) ELSE spend.open_until END,updated_at=?
          FROM expired WHERE spend.provider_key=expired.provider_key AND spend.key_source=expired.key_source AND spend.period_start=expired.period_start`)
          .bind(now, now),
        database
          .prepare(
            "UPDATE ai_spend_reservations SET actual_micros=estimated_micros,settled_at=? WHERE settled_at IS NULL AND expires_at<=?",
          )
          .bind(now, now),
        database.prepare("DELETE FROM analysis_idempotency_keys WHERE expires_at<=?").bind(now),
        database
          .prepare("DELETE FROM analysis_leases WHERE released_at IS NOT NULL OR expires_at<=?")
          .bind(now),
        database
          .prepare("DELETE FROM analysis_rate_limits WHERE window_started_at<=?")
          .bind(now - input.rateWindowSeconds * 1000),
        database.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(now),
        database.prepare("DELETE FROM verifications WHERE expires_at<=?").bind(now),
        database
          .prepare(
            "DELETE FROM ai_spend_reservations WHERE settled_at IS NOT NULL AND expires_at<=?",
          )
          .bind(now),
      ]);
      return {
        reservationsSettled: results[1]!.meta.changes,
        idempotencyKeysPurged: results[2]!.meta.changes,
        leasesPurged: results[3]!.meta.changes,
        rateWindowsPurged: results[4]!.meta.changes,
        sessionsPurged: results[5]!.meta.changes,
        verificationsPurged: results[6]!.meta.changes,
        reservationsPurged: results[7]!.meta.changes,
      };
    },
  };
}
