import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createScriptedRetrievalEnvironment,
  inputSnapshot,
  retrievalClaim,
  type ScriptedRetrievalSource,
} from "./support/scripted-retrieval.js";
import { createRetrieveEvidence } from "../src/analysis/retrieval/index.js";

const cli = parseArguments(process.argv.slice(2));
if (cli.mode !== "fixture" && cli.mode !== "replay") {
  throw new Error(
    "Only fixture and replay modes are available: no deployed search connector is wired, and live runs must not fall back to scripted evidence.",
  );
}

const fixtureUrl = new URL(
  "../src/analysis/retrieval/fixtures/retrieval-replay.json",
  import.meta.url,
);
const fixtureBytes = await readFile(fixtureUrl);
const manifest = JSON.parse(fixtureBytes.toString()) as Manifest;
if (cli.seed !== manifest.seed) throw new Error(`Replay seed must be ${manifest.seed}.`);

const checks = [];
for (const replayCase of manifest.cases) {
  const { environment } = createScriptedRetrievalEnvironment({
    sources: replayCase.sources,
    outage: replayCase.outage,
    budget: replayCase.budget === null ? undefined : { maxExternalRequests: replayCase.budget },
  });
  const result = await createRetrieveEvidence()(
    {
      claims: [retrievalClaim()],
      snapshots: [inputSnapshot()],
      round: 0,
      sufficiency: [],
    },
    environment,
  );
  const expected = replayCase.expected;
  const detected =
    result.status === expected.status &&
    (result.data?.stoppingReason ?? null) === expected.stoppingReason &&
    (result.data?.admittedSnapshotIds.length ?? 0) === expected.admitted &&
    (expected.role === null || result.data?.snapshots[0]?.role === expected.role) &&
    (expected.intent === null ||
      result.data?.candidates.some(({ queryIntent }) => queryIntent === expected.intent)) &&
    (expected.publishedAt === undefined ||
      result.data?.snapshots[0]?.timestampAssertions[0]?.interval.earliest ===
        expected.publishedAt) &&
    (replayCase.id !== "api-outage" ||
      result.issues.some(({ code }) => code === "provider_outage"));
  checks.push({
    id: replayCase.id,
    detected,
    numerator: detected ? 1 : 0,
    denominator: 1,
  });
}

const passed = checks.every(({ detected }) => detected);
const report = {
  reportVersion: "1.0.0",
  generatedAt: new Date().toISOString(),
  mode: cli.mode,
  split: cli.split,
  seed: cli.seed,
  fixtureVersion: manifest.version,
  fixtureLicense: manifest.license,
  datasetHash: `sha256:${createHash("sha256").update(fixtureBytes).digest("hex")}`,
  datasetCounts: { cases: manifest.cases.length, humanGoldClaims: manifest.humanGoldClaims },
  fixtureChecks: {
    status: passed ? "pass" : "fail",
    passed: checks.filter(({ detected }) => detected).length,
    failed: checks.filter(({ detected }) => !detected).length,
    checks,
  },
  metrics: {
    sufficientEvidenceRecall: {
      status: "not_evaluated",
      numerator: null,
      denominator: 0,
      value: null,
      target: ">= 0.90",
    },
  },
  empiricalGateStatus: "not_evaluated",
  releaseApproved: false,
  notes: [
    "All documents, provider responses, outages, and costs are deterministic synthetic replay fixtures.",
    "The fixtures verify retrieval invariants and code paths; they do not measure real-world retrieval recall.",
    "No network, live provider, human adjudication, paid request, or production service was used.",
  ],
};
const output = `${JSON.stringify(report, null, 2)}\n`;
if (cli.output) await writeFile(resolve(cli.output), output, "utf8");
process.stdout.write(output);
if (!passed) process.exitCode = 1;

interface Manifest {
  version: string;
  seed: number;
  license: string;
  humanGoldClaims: number;
  cases: Array<{
    id: string;
    description: string;
    sources: ScriptedRetrievalSource[];
    outage: boolean;
    budget: number | null;
    expected: {
      status: "complete" | "partial" | "unavailable" | "failed";
      stoppingReason:
        | "plan_complete"
        | "budget_exhausted"
        | "no_results"
        | "provider_outage"
        | null;
      admitted: number;
      role: "evidence" | "primary_record" | null;
      intent: ScriptedRetrievalSource["intents"][number] | null;
      publishedAt?: string;
    };
  }>;
}

function parseArguments(args: string[]) {
  const result: { mode: string; split: string; seed: number; output: string | null } = {
    mode: "fixture",
    split: "all",
    seed: 20260910,
    output: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index + 1];
    if (args[index] === "--mode" && value) result.mode = value;
    if (args[index] === "--split" && value) result.split = value;
    if (args[index] === "--seed" && value) result.seed = Number(value);
    if (args[index] === "--output" && value) result.output = value;
  }
  return result;
}
