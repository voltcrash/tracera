import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  PROVENANCE_CLAIM_TEXT,
  createProvenanceEnvironment,
  provenanceAssessment,
  provenanceClaim,
  provenanceSnapshot,
  scriptedArchive,
  scriptedProvenanceRetrieval,
} from "../scripts/support/scripted-provenance.js";
import { createTraceOrigins } from "../src/analysis/provenance/index.js";

const instant = (type: "published" | "updated", value: string) => ({
  type,
  interval: { earliest: value, latest: value, precision: "day" as const, timezone: "UTC" },
  source: "structured_data" as const,
  locatorId: null,
});

test("a known citation chain is traversed through retrieval and every new snapshot is assessed", async () => {
  const rootUrl = "https://reports.example/root";
  const middleUrl = "https://reports.example/middle";
  const recordUrl = "https://records.example/original";
  const root = provenanceSnapshot("root", rootUrl, ` Source: ${middleUrl}`);
  const middle = provenanceSnapshot("middle", middleUrl, ` Cites ${recordUrl}`);
  const record = provenanceSnapshot("record", recordUrl, "", [], "primary_record");
  const fixture = createProvenanceEnvironment();
  const result = await createTraceOrigins({
    retrieval: scriptedProvenanceRetrieval(
      new Map([
        [middleUrl, middle],
        [recordUrl, record],
      ]),
    ),
  })(
    { claims: [provenanceClaim()], snapshots: [root], assessments: [provenanceAssessment(root)] },
    fixture.environment,
  );
  assert.equal(result.status, "complete");
  assert.deepEqual(result.data?.newSnapshotIds, ["middle", "record"]);
  assert.equal(result.data?.graphs[0]?.nodes.length, 3);
  assert.equal(result.data?.graphs[0]?.edges.length, 2);
  assert.equal(result.data?.graphs[0]?.hopsUsed, 2);
  assert.equal(fixture.assessmentCalls, 2);
  assert.ok(
    fixture.audits.some(({ message }) => message.includes("returned through evidence assessment")),
  );
});

test("a backdated update remains an explicit chronology conflict", async () => {
  const snapshot = provenanceSnapshot("backdated", "https://reports.example/backdated", "", [
    instant("published", "2020-01-02T00:00:00.000Z"),
    instant("updated", "2020-01-01T00:00:00.000Z"),
  ]);
  const { environment } = createProvenanceEnvironment();
  const result = await createTraceOrigins()(
    {
      claims: [provenanceClaim()],
      snapshots: [snapshot],
      assessments: [provenanceAssessment(snapshot)],
    },
    environment,
  );
  assert.equal(result.status, "partial");
  assert.match(result.data!.graphs[0]!.chronologyConflicts[0]!.description, /update interval/u);
});

test("an archive before the declared date is claim-level evidence only after content assessment", async () => {
  const originalUrl = "https://reports.example/declared-late";
  const captureUrl = "https://archive.example/capture/2019";
  const original = provenanceSnapshot("late", originalUrl, "", [
    instant("published", "2020-01-02T00:00:00.000Z"),
  ]);
  const capture = provenanceSnapshot(
    "capture",
    captureUrl,
    ` Archived from ${originalUrl}`,
    [],
    "archive_capture",
  );
  const fixture = createProvenanceEnvironment();
  const result = await createTraceOrigins({
    retrieval: scriptedProvenanceRetrieval(new Map([[captureUrl, capture]])),
    archive: scriptedArchive(
      new Map([
        [originalUrl, [{ captureUrl, originalUrl, observedAt: "2019-12-31T00:00:00.000Z" }]],
      ]),
    ),
  })(
    {
      claims: [provenanceClaim()],
      snapshots: [original],
      assessments: [provenanceAssessment(original)],
    },
    fixture.environment,
  );
  const graph = result.data!.graphs[0]!;
  assert.ok(graph.edges.some(({ type }) => type === "archives"));
  assert.ok(
    graph.chronologyConflicts.some(({ description }) => description.includes("archive capture")),
  );
  assert.equal(
    graph.nodes.find(({ snapshotId }) => snapshotId === "capture")?.claimPresentInContent,
    true,
  );
  assert.equal(fixture.assessmentCalls, 1);
});

test("an archive URL without the claim remains document history, not claim-level existence", async () => {
  const originalUrl = "https://reports.example/original";
  const captureUrl = "https://archive.example/url-only";
  const original = provenanceSnapshot("url_original", originalUrl, "", [
    instant("published", "2020-01-02T00:00:00.000Z"),
  ]);
  const capture = provenanceSnapshot(
    "url_capture",
    captureUrl,
    `Archived from ${originalUrl}`,
    [],
    "archive_capture",
    false,
  );
  const { environment } = createProvenanceEnvironment();
  const result = await createTraceOrigins({
    retrieval: scriptedProvenanceRetrieval(new Map([[captureUrl, capture]])),
    archive: scriptedArchive(
      new Map([
        [originalUrl, [{ captureUrl, originalUrl, observedAt: "2019-12-31T00:00:00.000Z" }]],
      ]),
    ),
  })(
    {
      claims: [provenanceClaim()],
      snapshots: [original],
      assessments: [provenanceAssessment(original)],
    },
    environment,
  );
  const graph = result.data!.graphs[0]!;
  assert.equal(
    graph.nodes.find(({ snapshotId }) => snapshotId === "url_capture")?.claimPresentInContent,
    false,
  );
  assert.equal(graph.chronologyConflicts.length, 0);
  assert.ok(graph.edges.some(({ type }) => type === "archives"));
});

test("simultaneous statements remain tied earliest-observed candidates", async () => {
  const time = instant("published", "2020-01-01T00:00:00.000Z");
  const first = provenanceSnapshot("simultaneous_a", "https://a.example/report", "", [time]);
  const second = provenanceSnapshot("simultaneous_b", "https://b.example/report", "", [time]);
  const { environment } = createProvenanceEnvironment();
  const result = await createTraceOrigins()(
    {
      claims: [provenanceClaim()],
      snapshots: [first, second],
      assessments: [provenanceAssessment(first), provenanceAssessment(second)],
    },
    environment,
  );
  const roots = result.data!.graphs[0]!.candidateRoots.filter(
    ({ rootKind }) => rootKind === "earliest_observed_statement",
  );
  assert.equal(roots.length, 2);
  assert.ok(roots.every(({ rank }) => rank === 1));
  assert.ok(
    roots.every(({ signals }) => signals.some((signal) => signal.includes("Earliest observed"))),
  );
});

test("syndicated copies retain one dependency group and do not become independent roots", async () => {
  const time = instant("published", "2020-01-01T00:00:00.000Z");
  const first = provenanceSnapshot("wire_a", "https://a.example/wire", "", [time]);
  const second = provenanceSnapshot("wire_b", "https://b.example/wire", "", [time]);
  const dependence = {
    dependencyGroupId: "origin_wire",
    dependence: "syndicated_copy" as const,
    dependenceLocators: [
      {
        snapshotId: first.id,
        span: { start: 0, end: PROVENANCE_CLAIM_TEXT.length },
        quote: PROVENANCE_CLAIM_TEXT,
      },
    ],
  };
  const { environment } = createProvenanceEnvironment();
  const result = await createTraceOrigins()(
    {
      claims: [provenanceClaim()],
      snapshots: [first, second],
      assessments: [
        provenanceAssessment(first, dependence),
        provenanceAssessment(second, dependence),
      ],
    },
    environment,
  );
  assert.ok(result.data!.graphs[0]!.nodes.every(({ role }) => role === "syndication"));
  assert.equal(new Set([dependence.dependencyGroupId]).size, 1);
});

test("citation cycles are retained without recursive overrun", async () => {
  const firstUrl = "https://a.example/cycle";
  const secondUrl = "https://b.example/cycle";
  const first = provenanceSnapshot("cycle_a", firstUrl, ` Cites ${secondUrl}`);
  const second = provenanceSnapshot("cycle_b", secondUrl, ` Cites ${firstUrl}`);
  const { environment } = createProvenanceEnvironment();
  const result = await createTraceOrigins()(
    {
      claims: [provenanceClaim()],
      snapshots: [first, second],
      assessments: [provenanceAssessment(first), provenanceAssessment(second)],
    },
    environment,
  );
  assert.deepEqual(result.data!.graphs[0]!.cycles, [["cycle_a", "cycle_b", "cycle_a"]]);
  assert.ok(result.data!.graphs[0]!.hopsUsed <= 3);
});

test("an inaccessible original is explicit and never becomes a candidate root", async () => {
  const missingUrl = "https://missing.example/original";
  const source = provenanceSnapshot(
    "inaccessible",
    "https://report.example/story",
    ` Cites ${missingUrl}`,
  );
  const { environment } = createProvenanceEnvironment();
  const result = await createTraceOrigins({
    retrieval: scriptedProvenanceRetrieval(new Map()),
  })(
    {
      claims: [provenanceClaim()],
      snapshots: [source],
      assessments: [provenanceAssessment(source)],
    },
    environment,
  );
  assert.equal(result.status, "partial");
  assert.deepEqual(result.data!.graphs[0]!.inaccessibleOriginals, [
    { url: missingUrl, reason: "content_unavailable" },
  ]);
  assert.ok(
    result.data!.graphs[0]!.candidateRoots.every(({ snapshotId }) => snapshotId !== "missing"),
  );
  assert.equal(result.data!.graphs[0]!.globalOriginClaimed, false);
});

test("an unavailable archive capability is recorded without inventing a capture", async () => {
  const source = provenanceSnapshot("archive_unavailable", "https://report.example/archive");
  const { environment } = createProvenanceEnvironment();
  const result = await createTraceOrigins({
    archive: {
      provider: "unavailable-archive",
      async lookup(request) {
        return {
          status: "unavailable",
          data: null,
          issues: [
            {
              code: "capability_unavailable",
              severity: "warning",
              message: "Archive lookup is unavailable.",
              claimId: request.claimId,
              snapshotId: source.id,
              url: request.url,
            },
          ],
          metrics: {
            startedAt: "2026-09-14T00:00:00.000Z",
            completedAt: "2026-09-14T00:00:00.000Z",
            durationMs: 0,
            externalRequests: 0,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
          },
        };
      },
    },
  })(
    {
      claims: [provenanceClaim()],
      snapshots: [source],
      assessments: [provenanceAssessment(source)],
    },
    environment,
  );
  assert.equal(result.status, "partial");
  assert.equal(result.data!.graphs[0]!.searchLog[0]!.outcome, "unsupported");
  assert.equal(result.data!.graphs[0]!.nodes.length, 1);
  assert.ok(result.issues.some(({ code }) => code === "capability_unavailable"));
});

test("invalid validated assessment offsets are rejected and unknown dates stay unknown", async () => {
  const source = provenanceSnapshot("invalid_offset", "https://report.example/invalid");
  const invalid = provenanceAssessment(source, {
    excerpt: {
      span: { start: 1, end: PROVENANCE_CLAIM_TEXT.length },
      quote: PROVENANCE_CLAIM_TEXT,
      locatorId: source.locators[0]!.id,
    },
  });
  const { environment } = createProvenanceEnvironment();
  const result = await createTraceOrigins()(
    { claims: [provenanceClaim()], snapshots: [source], assessments: [invalid] },
    environment,
  );
  assert.equal(result.status, "partial");
  assert.equal(result.data!.graphs[0]!.nodes.length, 0);
  assert.equal(result.data!.graphs[0]!.searchedDateRange.earliest, null);
  assert.ok(result.issues.some(({ code }) => code === "citation_validation_failed"));
});

test("cancellation fails closed without returning partial provenance", async () => {
  const controller = new AbortController();
  controller.abort();
  const snapshot = provenanceSnapshot("canceled", "https://report.example/canceled");
  const { environment } = createProvenanceEnvironment({ signal: controller.signal });
  const result = await createTraceOrigins()(
    {
      claims: [provenanceClaim()],
      snapshots: [snapshot],
      assessments: [provenanceAssessment(snapshot)],
    },
    environment,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.data, null);
  assert.ok(result.issues.some(({ code }) => code === "cancellation_requested"));
});
