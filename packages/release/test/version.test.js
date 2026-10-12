import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getReleaseVersion } from "../src/version.js";

describe("release dates", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["2000-01-01T00:00:00Z", "v00.01.01"],
    ["2006-10-07T12:00:00Z", "v06.10.07"],
    ["2009-12-31T23:59:59Z", "v09.12.31"],
    ["2010-01-01T00:00:00Z", "v10.01.01"],
    ["2026-10-04T12:00:00Z", "v26.10.04"],
    ["2026-01-01T00:00:00Z", "v26.01.01"],
    ["2026-12-31T23:59:59Z", "v26.12.31"],
    ["2027-01-01T00:00:00Z", "v27.01.01"],
    ["2028-02-29T12:00:00Z", "v28.02.29"],
    ["2026-10-04T00:30:00+05:30", "v26.10.03"],
    ["2026-10-04T23:30:00-07:00", "v26.10.05"],
  ])("formats %s as %s", (date, expected) => {
    expect(getReleaseVersion(new Date(date))).toBe(expected);
  });

  it("uses the current date when no date is supplied", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
    expect(getReleaseVersion()).toBe("v26.10.04");
  });
});
