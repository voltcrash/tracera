export function utcPeriod(now: number) {
  const date = new Date(now);
  const periodStart = date.toISOString().slice(0, 10);
  const resetAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return { periodStart, resetAt };
}

export function usdToMicros(value: number) {
  const micros = Math.round(value * 1_000_000);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(micros))
    throw new RangeError(
      "USD amounts must be finite, non-negative and fit in integer micro-dollars.",
    );
  return micros;
}
export const microsToUsd = (value: number) => value / 1_000_000;
