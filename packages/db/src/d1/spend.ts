import type { D1RepositoryOptions } from "./repository.js";
import { AnalysisStorageConflictError } from "./repository.js";
import { microsToUsd, usdToMicros, utcPeriod } from "./clock.js";

type KeySource = "platform" | "user";
interface ReservationRow {
  id: string;
  provider_key: string;
  key_source: KeySource;
  period_start: string;
  estimated_micros: number;
  actual_micros: number | null;
  settled_at: number | null;
}
export type D1SpendAdmission =
  | {
      allowed: true;
      reservation: {
        id: string;
        providerKey: string;
        keySource: KeySource;
        estimatedUsd: number;
        resetAt: string;
      };
    }
  | { allowed: false; retryAt: string };

export class D1SpendRepository {
  private readonly database: D1RepositoryOptions["database"];
  private readonly now: () => number;
  constructor(options: D1RepositoryOptions) {
    this.database = options.database;
    this.now = options.now ?? Date.now;
  }

  async reserveProviderSpend(input: {
    providerKey: string;
    keySource?: KeySource;
    estimatedUsd: number;
    dailyBudgetUsd: number;
    reservationId?: string;
  }): Promise<D1SpendAdmission> {
    const now = this.now();
    const period = utcPeriod(now);
    const source = input.keySource ?? "platform";
    const estimate = usdToMicros(input.estimatedUsd);
    const budget = usdToMicros(input.dailyBudgetUsd);
    const id = input.reservationId ?? crypto.randomUUID();
    const token = crypto.randomUUID();
    const identity = [input.providerKey, source, period.periodStart];
    const results = await this.database.batch<ReservationRow>([
      this.database
        .prepare(`INSERT INTO ai_provider_spend(provider_key,key_source,period_start,budget_micros,reserved_micros,actual_micros,updated_at)
        SELECT ?,?,?,?,0,0,? WHERE NOT EXISTS(SELECT 1 FROM ai_spend_reservations WHERE id=?)
        ON CONFLICT(provider_key,key_source,period_start) DO UPDATE SET budget_micros=excluded.budget_micros,updated_at=excluded.updated_at`)
        .bind(...identity, budget, now, id),
      this.database
        .prepare(`INSERT INTO ai_spend_reservations(id,reservation_token,provider_key,key_source,period_start,estimated_micros,expires_at,created_at)
        SELECT ?,?,provider_key,key_source,period_start,?,?,? FROM ai_provider_spend
        WHERE provider_key=? AND key_source=? AND period_start=? AND (open_until IS NULL OR open_until<=?) AND ?>0 AND reserved_micros+actual_micros+?<=budget_micros
        AND NOT EXISTS(SELECT 1 FROM ai_spend_reservations WHERE id=?) ON CONFLICT(id) DO NOTHING`)
        .bind(id, token, estimate, now + 3_600_000, now, ...identity, now, estimate, estimate, id),
      this.database
        .prepare(`UPDATE ai_provider_spend SET reserved_micros=reserved_micros+?,updated_at=? WHERE provider_key=? AND key_source=? AND period_start=?
        AND EXISTS(SELECT 1 FROM ai_spend_reservations WHERE id=? AND reservation_token=?)`)
        .bind(estimate, now, ...identity, id, token),
      this.database
        .prepare(`UPDATE ai_provider_spend SET open_until=COALESCE(open_until,?),updated_at=? WHERE provider_key=? AND key_source=? AND period_start=?
        AND NOT EXISTS(SELECT 1 FROM ai_spend_reservations WHERE id=?)`)
        .bind(period.resetAt, now, ...identity, id),
      this.database.prepare("SELECT * FROM ai_spend_reservations WHERE id=?").bind(id),
    ]);
    const row = results[4]!.results[0];
    if (!row) return { allowed: false, retryAt: new Date(period.resetAt).toISOString() };
    if (
      row.provider_key !== input.providerKey ||
      row.key_source !== source ||
      row.estimated_micros !== estimate
    )
      throw new AnalysisStorageConflictError(
        "Spend reservation identity was reused with different immutable input.",
      );
    return {
      allowed: true,
      reservation: {
        id,
        providerKey: row.provider_key,
        keySource: row.key_source,
        estimatedUsd: microsToUsd(row.estimated_micros),
        resetAt: new Date(
          utcPeriod(Date.parse(`${row.period_start}T00:00:00Z`)).resetAt,
        ).toISOString(),
      },
    };
  }

  async settleProviderSpend(input: { reservationId: string; actualUsd: number }): Promise<void> {
    const row = await this.database
      .prepare("SELECT * FROM ai_spend_reservations WHERE id=?")
      .bind(input.reservationId)
      .first<ReservationRow>();
    if (!row || row.settled_at !== null) return;
    const actual =
      Number.isFinite(input.actualUsd) && input.actualUsd >= 0
        ? usdToMicros(input.actualUsd)
        : row.estimated_micros;
    const now = this.now();
    const reset = utcPeriod(Date.parse(`${row.period_start}T00:00:00Z`)).resetAt;
    await this.database.batch([
      this.database
        .prepare(`UPDATE ai_provider_spend SET reserved_micros=MAX(0,reserved_micros-?),actual_micros=actual_micros+?,
        open_until=CASE WHEN actual_micros+?>=budget_micros THEN COALESCE(open_until,?) ELSE open_until END,updated_at=?
        WHERE provider_key=? AND key_source=? AND period_start=? AND EXISTS(SELECT 1 FROM ai_spend_reservations WHERE id=? AND settled_at IS NULL)`)
        .bind(
          row.estimated_micros,
          actual,
          actual,
          reset,
          now,
          row.provider_key,
          row.key_source,
          row.period_start,
          input.reservationId,
        ),
      this.database
        .prepare(
          "UPDATE ai_spend_reservations SET actual_micros=?,settled_at=? WHERE id=? AND settled_at IS NULL",
        )
        .bind(actual, now, input.reservationId),
    ]);
  }
}

export function createD1SpendRepository(options: D1RepositoryOptions): D1SpendRepository {
  return new D1SpendRepository(options);
}
