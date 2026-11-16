import { expect, test } from "vite-plus/test";
import { completeRunReportExample } from "@repo/contracts/analysis";
import { buildImmutableTimeline } from "../src/analysis/timeline";
import { projectReport } from "../src/analysis/report-view";
import { selectPassageCandidates } from "../src/analysis/retrieval/passages";

test("timeline distinguishes known, missing-locator, and unknown timestamps", () => {
  const snapshot = structuredClone(completeRunReportExample.snapshots[0]!);
  const assertion = {
    type: "published" as const,
    source: "html_meta" as const,
    locatorId: null,
    interval: {
      earliest: "2026-09-01T00:00:00.000Z",
      latest: "2026-09-01T00:00:00.000Z",
      precision: "second" as const,
      timezone: "UTC",
    },
  };
  snapshot.timestampAssertions = [
    { ...assertion, locatorId: snapshot.locators[0]!.id },
    { ...assertion, locatorId: "missing" },
    {
      ...assertion,
      locatorId: null,
      interval: { earliest: null, latest: null, precision: null, timezone: null },
    },
  ];
  const entries = buildImmutableTimeline([snapshot]);
  expect(entries.find(({ id }) => id.endsWith(":0"))?.status).toBe("observed");
  expect(entries.find(({ id }) => id.endsWith(":1"))?.unresolvedReason).toBe(
    "timestamp_locator_unavailable",
  );
  expect(entries.find(({ id }) => id.endsWith(":2"))?.unresolvedReason).toBe("timestamp_unknown");
  expect(() => buildImmutableTimeline([snapshot, snapshot])).toThrow(
    "Duplicate immutable timeline",
  );
});

test("OCR observations drive visual verification without losing source offsets", () => {
  const report = structuredClone(completeRunReportExample);
  const snapshot = report.snapshots[0]!;
  const locator = snapshot.locators[0]!;
  locator.kind = "ocr_text";
  locator.transcriptionUncertain = true;
  const view = projectReport(report);
  expect(view.visualVerification.ocr).toBe("uncertain");
  expect(view.visualVerification.observations[0]).toMatchObject({
    snapshotId: snapshot.id,
    text: snapshot.normalizedText.slice(locator.span.start, locator.span.end),
    start: locator.span.start,
    end: locator.span.end,
  });
  locator.transcriptionUncertain = false;
  expect(projectReport(report).visualVerification.ocr).toBe("inspected");
});

test("passage scoring counts unique terms and preserves deterministic ranking", () => {
  const snapshot = structuredClone(completeRunReportExample.snapshots[0]!);
  const claim = structuredClone(completeRunReportExample.claims[0]!);
  claim.proposition = { subject: "alpha", predicate: "beta", object: "gamma", qualifiers: [] };
  claim.attribution.attributedTo = null;
  claim.quantities = [];
  claim.time.statedText = null;
  claim.place = null;
  snapshot.normalizedText = "alpha alpha\nalpha beta\nbeta gamma";
  snapshot.locators = [
    [0, 11],
    [12, 22],
    [23, 33],
  ].map(([start, end], i) => ({
    ...snapshot.locators[0]!,
    id: `loc_${i}`,
    span: { start: start!, end: end! },
  }));
  const candidates = selectPassageCandidates(snapshot, claim, 2);
  expect(candidates.map(({ lexicalScore }) => lexicalScore)).toEqual([2 / 3, 2 / 3]);
  expect(candidates.map(({ span }) => span.start)).toEqual([12, 23]);
  expect(selectPassageCandidates(snapshot, claim, 0)).toEqual([]);
});
