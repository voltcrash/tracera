import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createProvenanceEnvironment,
  provenanceAssessment,
  provenanceClaim,
  provenanceSnapshot,
  scriptedArchive,
  scriptedProvenanceRetrieval,
} from "./support/scripted-provenance.js";
import { createTraceOrigins } from "../src/analysis/provenance/index.js";

const arguments_ = new Map(
  process.argv
    .slice(2)
    .map((value, index, values) =>
      value.startsWith("--") ? [value.slice(2), values[index + 1] ?? "true"] : [value, "true"],
    ),
);
const mode = arguments_.get("mode") ?? "fixture";
const split = arguments_.get("split") ?? "all";
const seed = Number(arguments_.get("seed") ?? 20260910);
if (mode !== "fixture") throw new Error("Core provenance evaluation supports fixture mode only.");
if (split !== "all") throw new Error("The provenance invariant fixture has only the all split.");
if (seed !== 20260910) throw new Error("The provenance invariant fixture requires seed 20260910.");

const fixturePath = fileURLToPath(
  new URL("../src/analysis/provenance/fixtures/provenance-invariants.json", import.meta.url),
);
const fixtureBytes = await readFile(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString()) as { cases: string[]; humanGoldClaims: number };
const outcomes: Array<{ id: string; passed: boolean; error: string | null }> = [];

for (const id of fixture.cases) {
  try {
    await runCase(id);
    outcomes.push({ id, passed: true, error: null });
  } catch (error) {
    outcomes.push({
      id,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const passed = outcomes.filter(({ passed: value }) => value).length;
const report = {
  mode,
  split,
  seed,
  datasetHash: `sha256:${createHash("sha256").update(fixtureBytes).digest("hex")}`,
  cases: outcomes,
  counts: { passed, failed: outcomes.length - passed, skipped: 0 },
  originPrecision: {
    numerator: null,
    denominator: fixture.humanGoldClaims,
    status: "not_evaluated",
  },
  originCoverage: {
    numerator: null,
    denominator: fixture.humanGoldClaims,
    status: "not_evaluated",
  },
  empiricalGateStatus: "not_evaluated",
  releaseApproved: false,
};
console.log(JSON.stringify(report, null, 2));
if (passed !== outcomes.length) process.exitCode = 1;

async function runCase(id: string) {
  const claim = provenanceClaim();
  const day = (type: "published" | "updated", value: string) => ({
    type,
    interval: { earliest: value, latest: value, precision: "day" as const, timezone: "UTC" },
    source: "structured_data" as const,
    locatorId: null,
  });
  if (id === "known-citation-chain") {
    const middleUrl = "https://reports.example/middle";
    const recordUrl = "https://records.example/original";
    const root = provenanceSnapshot("root", "https://reports.example/root", ` Cites ${middleUrl}`);
    const middle = provenanceSnapshot("middle", middleUrl, ` Cites ${recordUrl}`);
    const record = provenanceSnapshot("record", recordUrl, "", [], "primary_record");
    const fixtureEnvironment = createProvenanceEnvironment();
    const result = await createTraceOrigins({
      retrieval: scriptedProvenanceRetrieval(
        new Map([
          [middleUrl, middle],
          [recordUrl, record],
        ]),
      ),
    })(
      { claims: [claim], snapshots: [root], assessments: [provenanceAssessment(root)] },
      fixtureEnvironment.environment,
    );
    assert.equal(result.data?.graphs[0]?.edges.length, 2);
    assert.equal(fixtureEnvironment.assessmentCalls, 2);
    return;
  }
  if (id === "backdated-update") {
    const snapshot = provenanceSnapshot("backdated", "https://reports.example/backdated", "", [
      day("published", "2020-01-02T00:00:00.000Z"),
      day("updated", "2020-01-01T00:00:00.000Z"),
    ]);
    const { environment } = createProvenanceEnvironment();
    const result = await createTraceOrigins()(
      { claims: [claim], snapshots: [snapshot], assessments: [provenanceAssessment(snapshot)] },
      environment,
    );
    assert.ok(result.data!.graphs[0]!.chronologyConflicts.length > 0);
    return;
  }
  if (id === "archive-before-declared-date") {
    const originalUrl = "https://reports.example/late";
    const captureUrl = "https://archive.example/2019";
    const original = provenanceSnapshot("late", originalUrl, "", [
      day("published", "2020-01-02T00:00:00.000Z"),
    ]);
    const capture = provenanceSnapshot(
      "capture",
      captureUrl,
      ` Archived from ${originalUrl}`,
      [],
      "archive_capture",
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
      { claims: [claim], snapshots: [original], assessments: [provenanceAssessment(original)] },
      environment,
    );
    assert.ok(result.data!.graphs[0]!.chronologyConflicts.length > 0);
    return;
  }
  if (id === "simultaneous-sources" || id === "syndication") {
    const timestamp = day("published", "2020-01-01T00:00:00.000Z");
    const first = provenanceSnapshot(`${id}_a`, "https://a.example/report", "", [timestamp]);
    const second = provenanceSnapshot(`${id}_b`, "https://b.example/report", "", [timestamp]);
    const overrides =
      id === "syndication"
        ? {
            dependencyGroupId: "one_wire",
            dependence: "syndicated_copy" as const,
            dependenceLocators: [
              {
                snapshotId: first.id,
                span: { start: 0, end: claim.text.length },
                quote: claim.text,
              },
            ],
          }
        : {};
    const { environment } = createProvenanceEnvironment();
    const result = await createTraceOrigins()(
      {
        claims: [claim],
        snapshots: [first, second],
        assessments: [
          provenanceAssessment(first, overrides),
          provenanceAssessment(second, overrides),
        ],
      },
      environment,
    );
    if (id === "simultaneous-sources")
      assert.equal(
        result.data!.graphs[0]!.candidateRoots.filter(
          ({ rootKind }) => rootKind === "earliest_observed_statement",
        ).length,
        2,
      );
    else assert.ok(result.data!.graphs[0]!.nodes.every(({ role }) => role === "syndication"));
    return;
  }
  if (id === "citation-cycle") {
    const firstUrl = "https://a.example/cycle";
    const secondUrl = "https://b.example/cycle";
    const first = provenanceSnapshot("cycle_a", firstUrl, ` Cites ${secondUrl}`);
    const second = provenanceSnapshot("cycle_b", secondUrl, ` Cites ${firstUrl}`);
    const { environment } = createProvenanceEnvironment();
    const result = await createTraceOrigins()(
      {
        claims: [claim],
        snapshots: [first, second],
        assessments: [provenanceAssessment(first), provenanceAssessment(second)],
      },
      environment,
    );
    assert.equal(result.data!.graphs[0]!.cycles.length, 1);
    return;
  }
  if (id === "inaccessible-original") {
    const missingUrl = "https://missing.example/original";
    const source = provenanceSnapshot(
      "missing",
      "https://report.example/story",
      ` Cites ${missingUrl}`,
    );
    const { environment } = createProvenanceEnvironment();
    const result = await createTraceOrigins({
      retrieval: scriptedProvenanceRetrieval(new Map()),
    })(
      { claims: [claim], snapshots: [source], assessments: [provenanceAssessment(source)] },
      environment,
    );
    assert.deepEqual(result.data!.graphs[0]!.inaccessibleOriginals, [
      { url: missingUrl, reason: "content_unavailable" },
    ]);
    return;
  }
  throw new Error(`Unknown provenance fixture case: ${id}`);
}
