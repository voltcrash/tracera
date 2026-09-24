import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  assessmentResponse,
  createScriptedEvidenceEnvironment,
  evidenceClaim,
  evidenceSnapshot,
} from "./support/scripted-evidence.js";
import { assignSourceDependence, createAssessEvidence } from "../src/analysis/evidence/index.js";

const fixtureUrl = new URL(
  "../src/analysis/evidence/fixtures/evidence-invariants.json",
  import.meta.url,
);
const bytes = await readFile(fileURLToPath(fixtureUrl));
const fixture = JSON.parse(bytes.toString("utf8")) as {
  version: string;
  cases: Array<{
    id: string;
    quote: string;
    mutation: "none" | "denominator" | "source-id" | "excerpt" | "syndication";
    expected: "rejected" | "one-origin-group";
  }>;
};
const args = new Map(
  process.argv
    .slice(2)
    .flatMap((value, index, values) =>
      value.startsWith("--") ? [[value, values[index + 1] ?? ""]] : [],
    ),
);
if (args.get("--mode") !== "fixture")
  throw new Error(
    "Task 07 evidence evaluation supports fixture mode only; live and replay providers are not configured.",
  );
const results: Array<{ id: string; passed: boolean }> = [];

for (const fixtureCase of fixture.cases) {
  if (fixtureCase.mutation === "syndication") {
    const claim = evidenceClaim();
    const assessments = [];
    const snapshots = [];
    for (let index = 0; index < 10; index += 1) {
      const snapshot = evidenceSnapshot(`evaluation_copy_${index}`, fixtureCase.quote, {
        url: `https://copy${index}.example/story`,
      });
      const { environment } = createScriptedEvidenceEnvironment(({ claim, snapshotId }) =>
        assessmentResponse(claim, snapshotId, fixtureCase.quote),
      );
      const result = await createAssessEvidence()(
        { claims: [claim], snapshots: [snapshot], admittedSnapshotIds: [snapshot.id] },
        environment,
      );
      assessments.push(result.data!.assessments[0]!);
      snapshots.push(snapshot);
    }
    results.push({
      id: fixtureCase.id,
      passed:
        new Set(
          assignSourceDependence(assessments, snapshots).map(
            ({ dependencyGroupId }) => dependencyGroupId,
          ),
        ).size === 1,
    });
    continue;
  }
  const denominator = fixtureCase.mutation === "denominator";
  const claim = denominator
    ? evidenceClaim({
        text: "Northbridge completed 20% of 100 inspections in 1998.",
        proposition: {
          subject: "Northbridge",
          predicate: "completed",
          object: "20% of 100 inspections",
          qualifiers: ["in 1998"],
        },
        quantities: [
          {
            rawText: "20%",
            value: 20,
            unit: "%",
            denominatorText: "100 inspections",
            kind: "percentage",
          },
        ],
      })
    : evidenceClaim();
  const snapshot = evidenceSnapshot(`evaluation_${fixtureCase.id}`, fixtureCase.quote);
  const { environment } = createScriptedEvidenceEnvironment(({ claim, snapshotId }) =>
    assessmentResponse(
      claim,
      fixtureCase.mutation === "source-id" ? "fake_snapshot" : snapshotId,
      fixtureCase.mutation === "excerpt" ? "Invented excerpt." : fixtureCase.quote,
    ),
  );
  const result = await createAssessEvidence()(
    { claims: [claim], snapshots: [snapshot], admittedSnapshotIds: [snapshot.id] },
    environment,
  );
  const referenceFailure =
    fixtureCase.mutation === "source-id" || fixtureCase.mutation === "excerpt";
  results.push({
    id: fixtureCase.id,
    passed: referenceFailure
      ? result.data?.assessments.length === 0 &&
        result.issues.some(({ code }) => code === "citation_validation_failed")
      : result.data?.assessments[0]?.validationStatus === fixtureCase.expected,
  });
}

const passed = results.filter((result) => result.passed).length;
const report = {
  mode: "fixture",
  split: args.get("--split") ?? "all",
  seed: Number(args.get("--seed") ?? 20260910),
  fixtureVersion: fixture.version,
  datasetHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  counts: {
    cases: results.length,
    passed,
    failed: results.length - passed,
    skipped: 0,
    humanGoldClaims: 0,
  },
  results,
  empiricalEvidenceValidity: { numerator: null, denominator: 0, status: "not_evaluated" },
  releaseApproved: false,
};
console.log(JSON.stringify(report, null, 2));
if (passed !== results.length) process.exitCode = 1;
