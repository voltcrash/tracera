import { expect, test } from "vite-plus/test";
import { analysisExamples, type StageResult } from "@repo/contracts/analysis";
import { createScriptedEvidenceEnvironment } from "../scripts/support/scripted-evidence.js";
import type { RunEnvironment } from "../src/analysis/types.js";
import { createRunAnalysis } from "../src/analysis/index.js";
import { normalizeInput } from "../src/analysis/ingestion/index.js";
import { extractClaims } from "../src/analysis/claims/index.js";
import { retrieveEvidence } from "../src/analysis/retrieval/index.js";
import { assessEvidence } from "../src/analysis/evidence/index.js";
import { traceOrigins } from "../src/analysis/provenance/index.js";
import { adjudicateClaims } from "../src/analysis/adjudication/index.js";
import { createFocusedPublication } from "../src/analysis/publication/index.js";
const example = analysisExamples.complete;
const input = { input: { kind: "text" as const, text: "A claim." }, seed: 1 };
const fixture = () =>
  createScriptedEvidenceEnvironment(() => {
    throw new Error("Unexpected provider request");
  });
const stages: [string, (env: RunEnvironment) => Promise<StageResult<unknown>>][] = [
  ["normalization", (env) => normalizeInput(input, env)],
  [
    "extraction",
    (env) =>
      extractClaims(
        { snapshots: example.snapshots, primarySnapshotId: example.primarySnapshotId! },
        env,
      ),
  ],
  [
    "retrieval",
    (env) =>
      retrieveEvidence(
        { claims: example.claims, snapshots: example.snapshots, round: 0, sufficiency: [] },
        env,
      ),
  ],
  [
    "assessment",
    (env) =>
      assessEvidence(
        { claims: example.claims, snapshots: example.snapshots, admittedSnapshotIds: [] },
        env,
      ),
  ],
  [
    "provenance",
    (env) =>
      traceOrigins(
        { claims: example.claims, snapshots: example.snapshots, assessments: example.assessments },
        env,
      ),
  ],
  [
    "adjudication",
    (env) =>
      adjudicateClaims(
        { claims: example.claims, assessments: example.assessments, graphs: example.provenance },
        env,
      ),
  ],
  [
    "publication",
    (env) =>
      createFocusedPublication()(
        {
          claims: example.claims,
          snapshots: example.snapshots,
          decisions: example.decisions,
          assessments: example.assessments,
        },
        env,
      ),
  ],
];

test.each(stages)(
  "%s reports deadline interruption without owner cancellation",
  async (_name, execute) => {
    const { environment, audits } = fixture();
    environment.signal = AbortSignal.abort(new DOMException("Deadline", "TimeoutError"));
    const result = await execute(environment);
    expect(result).toMatchObject({ status: "failed", data: null });
    expect(result.issues.some(({ code }) => code === "timeout")).toBe(true);
    expect(result.issues.some(({ code }) => code === "cancellation_requested")).toBe(false);
    expect(audits.some(({ kind }) => kind === "cancellation")).toBe(false);
  },
);

test("a deadline that aborts acquisition remains a timeout", async () => {
  const { environment } = fixture();
  const controller = new AbortController();
  environment.signal = controller.signal;
  environment.ports.documents.acquireFromText = async () => {
    controller.abort(new DOMException("Deadline", "TimeoutError"));
    controller.signal.throwIfAborted();
    throw new Error("Unreachable");
  };
  const result = await createRunAnalysis()(input, environment);
  expect(result.status).toBe("failed");
  expect(result.issues.some(({ code }) => code === "timeout")).toBe(true);
  expect(result.issues.some(({ code }) => code === "cancellation_requested")).toBe(false);
});

for (const reason of ["user_request", "timeout", "budget_exhausted"] as const) {
  test(`context stop reason ${reason} has explicit precedence over a deadline signal`, async () => {
    const { environment } = fixture();
    environment.context.cancellation = { requested: true, requestedAt: example.createdAt, reason };
    environment.signal = AbortSignal.abort(new DOMException("Deadline", "TimeoutError"));
    const result = await createRunAnalysis()(input, environment);
    expect(result.status).toBe(reason === "user_request" ? "canceled" : "failed");
    expect(result.issues[0]!.code).toBe(
      reason === "user_request" ? "cancellation_requested" : reason,
    );
    expect(result.report!.stageOutcomes[0]!.issues[0]!.code).toBe(result.issues[0]!.code);
  });
}
