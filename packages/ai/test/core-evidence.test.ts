import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  assessmentResponse,
  createScriptedEvidenceEnvironment,
  evidenceClaim,
  evidenceSnapshot,
} from "../scripts/support/scripted-evidence.js";
import {
  assignSourceDependence,
  buildChallengeInput,
  createAssessEvidenceV2,
} from "../src/core/evidence/index.js";

async function run(
  text: string,
  response: Parameters<typeof createScriptedEvidenceEnvironment>[0],
  claim = evidenceClaim(),
) {
  const snapshot = evidenceSnapshot("snap_evidence", text);
  const { environment, audits } = createScriptedEvidenceEnvironment(response);
  const result = await createAssessEvidenceV2()(
    { claims: [claim], snapshots: [snapshot], admittedSnapshotIds: [snapshot.id] },
    environment,
  );
  return { result, snapshot, audits };
}

test("valid exact evidence is retained with mechanically derived UTF-16 offsets", async () => {
  const quote = "Northbridge recorded 42 incidents in 1998.";
  const { result } = await run(`Preface. ${quote}`, ({ claim, snapshotId }) =>
    assessmentResponse(claim, snapshotId, quote),
  );
  assert.equal(result.status, "complete");
  assert.equal(result.data?.assessments[0]?.excerpt.span.start, 9);
  assert.equal(result.data?.assessments[0]?.validationStatus, "validated");
  assert.equal(result.data?.sufficiency[0]?.sufficient, true);
});

test("wrong-person and wrong-year passages cannot validate as support", async () => {
  for (const quote of [
    "Southbridge recorded 42 incidents in 1998.",
    "Northbridge recorded 42 incidents in 1999.",
  ]) {
    const { result } = await run(quote, ({ claim, snapshotId }) =>
      assessmentResponse(claim, snapshotId, quote),
    );
    assert.equal(result.data?.assessments[0]?.validationStatus, "rejected");
    assert.ok(result.data?.assessments[0]?.checks.some(({ result: check }) => check === "fail"));
  }
});

test("a quoted false allegation does not support the underlying assertion", async () => {
  const quote = "The mayor falsely alleged Northbridge recorded 42 incidents in 1998.";
  const { result } = await run(quote, ({ claim, snapshotId }) =>
    assessmentResponse(claim, snapshotId, quote),
  );
  assert.equal(result.data?.assessments[0]?.validationStatus, "rejected");
  assert.equal(
    result.data?.assessments[0]?.checks.find(({ check }) => check === "attribution")?.result,
    "fail",
  );
});

test("altered denominators are rejected and available operands are calculated", async () => {
  const claim = evidenceClaim({
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
  });
  const good = "Northbridge completed 20 of 100 inspections in 1998.";
  const { result: calculated } = await run(
    good,
    ({ claim, snapshotId }) => assessmentResponse(claim, snapshotId, good),
    claim,
  );
  assert.equal(calculated.data?.assessments[0]?.calculation?.result, 20);
  assert.equal(calculated.data?.assessments[0]?.validationStatus, "validated");
  const altered = "Northbridge completed 20 of 200 inspections in 1998.";
  const { result } = await run(
    altered,
    ({ claim, snapshotId }) => assessmentResponse(claim, snapshotId, altered),
    claim,
  );
  assert.equal(result.data?.assessments[0]?.validationStatus, "rejected");
});

test("fake source IDs and invented excerpts fail closed with typed audit evidence", async () => {
  const quote = "Northbridge recorded 42 incidents in 1998.";
  const fakeId = await run(quote, ({ claim }) => assessmentResponse(claim, "snap_fake", quote));
  assert.equal(fakeId.result.data?.assessments.length, 0);
  assert.ok(fakeId.result.issues.some(({ code }) => code === "citation_validation_failed"));
  const fakeQuote = await run(quote, ({ claim, snapshotId }) =>
    assessmentResponse(claim, snapshotId, "Invented quote."),
  );
  assert.equal(fakeQuote.result.data?.assessments.length, 0);
  assert.ok(fakeQuote.audits.some(({ kind }) => kind === "validation_rejected"));
});

test("ten syndicated copies collapse to one known origin group", async () => {
  const claim = evidenceClaim();
  const quote = "Northbridge recorded 42 incidents in 1998.";
  const assessments = [];
  const snapshots = [];
  for (let index = 0; index < 10; index += 1) {
    const snapshot = evidenceSnapshot(`copy_${index}`, quote, {
      url: `https://publisher${index}.example/copy`,
    });
    const { environment } = createScriptedEvidenceEnvironment(({ claim, snapshotId }) =>
      assessmentResponse(claim, snapshotId, quote),
    );
    const result = await createAssessEvidenceV2()(
      { claims: [claim], snapshots: [snapshot], admittedSnapshotIds: [snapshot.id] },
      environment,
    );
    assessments.push(result.data!.assessments[0]!);
    snapshots.push(snapshot);
  }
  const grouped = assignSourceDependence(assessments, snapshots);
  assert.equal(new Set(grouped.map(({ dependencyGroupId }) => dependencyGroupId)).size, 1);
  assert.equal(grouped.filter(({ dependence }) => dependence === "syndicated_copy").length, 9);
  assert.ok(grouped.slice(1).every(({ dependenceLocators }) => dependenceLocators.length === 1));
});

test("unknown dependence, submitted assertions, and conflicting evidence remain explicit", async () => {
  const claim = evidenceClaim();
  const support = evidenceSnapshot("submitted", "Northbridge recorded 42 incidents in 1998.", {
    role: "submitted_input",
  });
  const contradiction = evidenceSnapshot(
    "secondary",
    "Northbridge recorded 41, not 42, incidents in 1998.",
  );
  const { environment } = createScriptedEvidenceEnvironment(({ claim, snapshotId, passage }) =>
    assessmentResponse(claim, snapshotId, passage, {
      relation: snapshotId === "secondary" ? "contradicts" : "supports",
      directness: "secondary",
    }),
  );
  const result = await createAssessEvidenceV2()(
    {
      claims: [claim],
      snapshots: [support, contradiction],
      admittedSnapshotIds: [support.id, contradiction.id],
    },
    environment,
  );
  assert.deepEqual(
    new Set(result.data?.assessments.map(({ relation }) => relation)),
    new Set(["supports", "contradicts"]),
  );
  assert.ok(result.data?.assessments.every(({ dependence }) => dependence === "unknown"));
  assert.equal(result.data?.sufficiency[0]?.independentOriginCount, 0);
});

test("challenge input contains admissible evidence and never accepts a draft label", async () => {
  const claim = evidenceClaim();
  const quote = "Northbridge recorded 42 incidents in 1998.";
  const { result } = await run(quote, ({ claim, snapshotId }) =>
    assessmentResponse(claim, snapshotId, quote),
  );
  const challenge = buildChallengeInput(claim, result.data!.assessments);
  assert.equal(challenge.evidence.length, 1);
  assert.equal("draftLabel" in challenge, false);
  assert.equal("rawModelConfidence" in challenge, false);
});

test("needs-context claims are assessed as written but never reported sufficient", async () => {
  const claim = evidenceClaim({
    text: "They recorded 42 incidents in 1998.",
    proposition: {
      subject: "They",
      predicate: "recorded",
      object: "42 incidents",
      qualifiers: ["in 1998"],
    },
    unresolvedContext: ["They has no antecedent."],
    checkability: "needs_context",
    place: null,
  });
  const quote = "They recorded 42 incidents in 1998.";
  const { result } = await run(
    quote,
    ({ claim, snapshotId }) => assessmentResponse(claim, snapshotId, quote),
    claim,
  );
  assert.equal(result.data?.assessments.length, 1);
  assert.equal(result.data?.sufficiency[0]?.sufficient, false);
});

test("same-publisher documents share a non-independent group", async () => {
  const claim = evidenceClaim();
  const first = evidenceSnapshot("desk_a", "Northbridge recorded 42 incidents in 1998.", {
    url: "https://wire.example/a",
  });
  const second = evidenceSnapshot(
    "desk_b",
    "The Northbridge ledger recorded 42 incidents during 1998.",
    { url: "https://wire.example/b" },
  );
  const { environment } = createScriptedEvidenceEnvironment(({ claim, snapshotId, passage }) =>
    assessmentResponse(claim, snapshotId, passage),
  );
  const result = await createAssessEvidenceV2()(
    {
      claims: [claim],
      snapshots: [first, second],
      admittedSnapshotIds: [first.id, second.id],
    },
    environment,
  );
  assert.ok(result.data?.assessments.every(({ dependence }) => dependence === "same_publisher"));
  assert.equal(
    new Set(result.data?.assessments.map(({ dependencyGroupId }) => dependencyGroupId)).size,
    1,
  );
});

test("multiple passages from one snapshot never inflate independent-origin counts", async () => {
  const claim = evidenceClaim();
  const sentence = "Northbridge recorded 42 incidents in 1998.";
  const snapshot = evidenceSnapshot("multi_passage", `${sentence}\n${sentence}`);
  snapshot.locators = [
    { ...snapshot.locators[0]!, id: "first", span: { start: 0, end: sentence.length } },
    {
      ...snapshot.locators[0]!,
      id: "second",
      span: { start: sentence.length + 1, end: sentence.length * 2 + 1 },
    },
  ];
  const { environment } = createScriptedEvidenceEnvironment(({ claim, snapshotId, passage }) =>
    assessmentResponse(claim, snapshotId, passage),
  );
  const result = await createAssessEvidenceV2()(
    { claims: [claim], snapshots: [snapshot], admittedSnapshotIds: [snapshot.id] },
    environment,
  );
  assert.equal(result.data?.assessments.length, 2);
  assert.equal(
    new Set(result.data?.assessments.map(({ dependencyGroupId }) => dependencyGroupId)).size,
    1,
  );
  assert.equal(result.data?.sufficiency[0]?.independentOriginCount, 1);
});

test("unknown admitted IDs fail closed and cancellation produces no data", async () => {
  const claim = evidenceClaim();
  const snapshot = evidenceSnapshot("known", "Northbridge recorded 42 incidents in 1998.");
  const scripted = createScriptedEvidenceEnvironment(({ claim, snapshotId, passage }) =>
    assessmentResponse(claim, snapshotId, passage),
  );
  const missing = await createAssessEvidenceV2()(
    { claims: [claim], snapshots: [snapshot], admittedSnapshotIds: ["missing"] },
    scripted.environment,
  );
  assert.equal(missing.status, "failed");
  assert.equal(missing.data, null);
  const canceled = createScriptedEvidenceEnvironment(
    ({ claim, snapshotId, passage }) => assessmentResponse(claim, snapshotId, passage),
    { cancelRequested: true },
  );
  const result = await createAssessEvidenceV2()(
    { claims: [claim], snapshots: [snapshot], admittedSnapshotIds: [snapshot.id] },
    canceled.environment,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.data, null);
});
