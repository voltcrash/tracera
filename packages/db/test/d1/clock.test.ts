import { expect, test } from "vite-plus/test";
import { microsToUsd, usdToMicros, utcPeriod } from "../../src/d1/clock.js";

test("UTC periods cross midnight and month boundaries without local-time offsets", () => {
  expect(utcPeriod(Date.parse("2026-10-31T23:59:59.999Z"))).toEqual({
    periodStart: "2026-10-31",
    resetAt: Date.parse("2026-11-01T00:00:00.000Z"),
  });
  expect(utcPeriod(Date.parse("2026-11-01T00:00:00.000Z")).periodStart).toBe("2026-11-01");
});

test("spend values round-trip at the existing six-decimal USD precision", () => {
  for (const value of [0, 0.000001, 0.005, 0.01, 0.3, 25.123456])
    expect(microsToUsd(usdToMicros(value))).toBe(value);
  expect(usdToMicros(0.0000005)).toBe(1);
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    expect(() => usdToMicros(value)).toThrow(RangeError);
});
