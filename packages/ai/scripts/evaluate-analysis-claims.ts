/*
 * Claim-inventory evaluation. Fixture mode replays scripted generation output
 * through the claim extractor and aligns the result with a synthetic
 * inventory. Synthetic entries are excluded from empirical metrics, so those
 * stay not_evaluated until adjudicated human gold exists.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runContextExample, type DocumentSnapshot } from "@repo/contracts/analysis";
import { evaluateRun } from "../evaluation/harness.js";
import {
  evaluationDatasetSchema,
  splitIdSchema,
  type EvaluationDataset,
} from "../evaluation/schemas.js";
import {
  createClaimExtractionAdapter,
  createExtractClaims,
  matchInventoryToGold,
  summarizeInventory,
  type ClaimExtractionAdapterOptions,
} from "../src/analysis/claims/index.js";
import { createDocumentAcquisitionPort } from "../src/analysis/ingestion/index.js";
import type { AuditEvent, RunEnvironment } from "../src/analysis/types.js";
import {
  createScriptedClaimGeneration,
  type ClaimScript,
} from "./support/scripted-claim-generation.js";

const FIXTURE_CLOCK = "2026-09-10T00:00:00.000Z";
const fixtures = new URL("../src/analysis/claims/fixtures/", import.meta.url);
const cli = parseArguments(process.argv.slice(2));
if (cli.mode !== "fixture") {
  throw new Error(
    "Only fixture mode is available: no production GenerationPort connector is wired for claim extraction yet, and replay or live runs must not fall back to fixtures.",
  );
}

const datasetPath = new URL("claim-inventory.dataset.json", fixtures).pathname;
const dataset = evaluationDatasetSchema.parse(JSON.parse(await readFile(datasetPath, "utf8")));
const scripts = JSON.parse(
  await readFile(new URL("claim-inventory.script.json", fixtures), "utf8"),
) as Record<string, ClaimScript>;
const extract = createExtractClaims({ maxChunkCharacters: 200, overlapCharacters: 60 });

const adapter = createClaimExtractionAdapter({
  id: "tracera-claim-inventory",
  version: "1.0.0",
  modes: ["fixture"],
  extract,
  createEnvironment: (document) => fixtureEnvironment(scriptFor(document.id)),
});
const run = await adapter.evaluate(dataset, { mode: "fixture", split: cli.split, seed: cli.seed });
const evaluated = evaluateRun(dataset, run, { split: cli.split, seed: cli.seed });
const selectedGold = evaluated.dataset.claims;
const matched = run.extractionMatches.filter((match) => match.status === "matched").length;

const checks = [
  {
    id: "synthetic-inventory-alignment",
    detected:
      matched === selectedGold.length &&
      run.extractionMatches.every((match) => match.status === "matched"),
    numerator: matched,
    denominator: selectedGold.length,
    note: "Code-path agreement with a synthetic inventory; not an accuracy measurement.",
  },
  await droppedClaimCheck(),
  await selfReportedCoverageCheck(),
  await fabricatedQuoteCheck(),
  await unsupportedLanguageCheck(),
  await opinionOnlyCheck(),
  {
    id: "empirical-metrics-not-evaluated-without-human-gold",
    detected:
      evaluated.datasetCounts.humanGoldClaims > 0 ||
      (evaluated.metrics.claimExtraction.recall.status === "not_evaluated" &&
        evaluated.metrics.claimExtraction.semanticPrecision.status === "not_evaluated"),
    numerator: null,
    denominator: evaluated.metrics.claimExtraction.recall.denominator,
    note: "Synthetic inventory entries never enter recall or precision denominators.",
  },
];
const passed = checks.every((check) => check.detected) && evaluated.integrityIssues.length === 0;

const report = {
  reportVersion: "1.0.0",
  generatedAt: new Date().toISOString(),
  mode: cli.mode,
  split: cli.split,
  seed: cli.seed,
  datasetPath,
  adapter: {
    id: run.adapterId,
    version: run.adapterVersion,
    contractVersion: adapter.contractVersion,
  },
  datasetHash: evaluated.datasetHash,
  datasetCounts: evaluated.datasetCounts,
  integrityIssues: evaluated.integrityIssues,
  extractionMatchCounts: countBy(run.extractionMatches.map((match) => match.status)),
  outages: run.outages,
  fixtureChecks: { status: passed ? "pass" : "fail", checks },
  empiricalGateStatus: "not_evaluated",
  releaseApproved: false,
  metrics: { claimExtraction: evaluated.metrics.claimExtraction },
  notes: [
    "Fixture results are code-path evidence, not empirical extraction accuracy.",
    "Generation output is scripted; no model or provider was called.",
    "Recall and semantic precision require an independently adjudicated human claim inventory.",
  ],
};
const output = `${JSON.stringify(report, null, 2)}\n`;
if (cli.output) await writeFile(resolve(cli.output), output, "utf8");
process.stdout.write(output);
if (!passed) process.exitCode = 1;

async function droppedClaimCheck() {
  const script = scriptFor("doc-multi");
  const reduced = {
    ...script,
    claims: script.claims.filter((claim) => claim.localId !== "plant-5"),
  };
  const matches = await matchesFor("doc-multi", reduced);
  const missed = matches
    .filter((match) => match.status === "missed")
    .map((match) => match.goldClaimId);
  return {
    id: "dropped-claim-reported-missed",
    detected: missed.length === 1 && missed[0] === "gold-plant-5",
    numerator: missed.length,
    denominator: 1,
    note: "Removing one scripted claim must surface exactly one missed gold claim.",
  };
}

async function selfReportedCoverageCheck() {
  const document = documentFor("doc-negation");
  const environment = fixtureEnvironment({ segments: [], claims: [] });
  const snapshot = await acquire(document, environment);
  const result = await extract(
    { snapshots: [snapshot], primarySnapshotId: snapshot.id },
    environment,
  );
  const matches = matchInventoryToGold({
    documentId: document.id,
    goldClaims: dataset.claims,
    claims: result.data?.claims ?? [],
  });
  return {
    id: "extractor-self-report-ignored",
    detected: matches.some(
      (match) => match.goldClaimId === "gold-negation" && match.status === "missed",
    ),
    numerator: null,
    denominator: 1,
    note: "An inventory with no claims is scored missed regardless of what its coverage audit claims.",
  };
}

async function fabricatedQuoteCheck() {
  const script = scriptFor("doc-negation");
  const fabricated: ClaimScript = {
    ...script,
    claims: script.claims.map((claim) => ({
      ...claim,
      sourceQuotes: [{ quote: "The council rejected the budget in 2024.", in: "The council" }],
    })),
  };
  const environment = fixtureEnvironment(fabricated);
  const snapshot = await acquire(documentFor("doc-negation"), environment);
  const result = await extract(
    { snapshots: [snapshot], primarySnapshotId: snapshot.id },
    environment,
  );
  return {
    id: "fabricated-quote-rejected",
    detected:
      result.data?.claims.length === 0 &&
      result.issues.some((issue) => issue.code === "citation_validation_failed"),
    numerator: null,
    denominator: 1,
    note: "A quote that is not an exact substring is rejected with a typed issue.",
  };
}

async function unsupportedLanguageCheck() {
  const environment = fixtureEnvironment(scriptFor("doc-unsupported"));
  const snapshot = await acquire(documentFor("doc-unsupported"), environment);
  const result = await extract(
    { snapshots: [snapshot], primarySnapshotId: snapshot.id },
    environment,
  );
  return {
    id: "unsupported-language-unavailable",
    detected: result.status === "unavailable" && result.issues[0]?.code === "unsupported_language",
    numerator: null,
    denominator: 1,
    note: "Unsupported languages receive an explicit unavailable status.",
  };
}

async function opinionOnlyCheck() {
  const environment = fixtureEnvironment(scriptFor("doc-opinion"));
  const snapshot = await acquire(documentFor("doc-opinion"), environment);
  const result = await extract(
    { snapshots: [snapshot], primarySnapshotId: snapshot.id },
    environment,
  );
  return {
    id: "opinion-only-no-checkable-claims",
    detected:
      result.status === "complete" &&
      result.data !== null &&
      summarizeInventory(result.data).noCheckableClaims,
    numerator: null,
    denominator: 1,
    note: "Opinion-only input is a complete no-claim inventory, never zero accuracy.",
  };
}

async function matchesFor(documentId: string, script: ClaimScript) {
  const document = documentFor(documentId);
  const environment = fixtureEnvironment(script);
  const snapshot = await acquire(document, environment);
  const result = await extract(
    { snapshots: [snapshot], primarySnapshotId: snapshot.id },
    environment,
  );
  return matchInventoryToGold({
    documentId,
    goldClaims: dataset.claims,
    claims: result.data?.claims ?? [],
  });
}

async function acquire(
  document: EvaluationDataset["documents"][number],
  environment: RunEnvironment,
): Promise<DocumentSnapshot> {
  const result = await environment.ports.documents.acquireFromText({
    text: document.text,
    role: "submitted_input",
    signal: environment.signal,
  });
  if (!result.data) throw new Error(`Fixture document ${document.id} could not be acquired.`);
  return result.data.snapshot;
}

function documentFor(id: string) {
  const document = dataset.documents.find((candidate) => candidate.id === id);
  if (!document) throw new Error(`Fixture document ${id} is missing.`);
  return document;
}

function scriptFor(id: string): ClaimScript {
  const script = scripts[id];
  if (!script)
    throw new Error(
      `No scripted generation exists for ${id}; fixtures never fall back to a provider.`,
    );
  return script;
}

function fixtureEnvironment(
  script: ClaimScript,
): ReturnType<ClaimExtractionAdapterOptions["createEnvironment"]> {
  const audit: AuditEvent[] = [];
  const stored = new Map<string, DocumentSnapshot>();
  const unused = () => {
    throw new Error("This port is not used by claim-inventory fixtures.");
  };
  return {
    context: { ...runContextExample, executionMode: "fixture" },
    signal: new AbortController().signal,
    ports: {
      generation: createScriptedClaimGeneration(script),
      embeddings: { modelId: "unused", dimensions: 1024, preprocessing: "unused", embed: unused },
      search: [],
      documents: createDocumentAcquisitionPort({ now: () => FIXTURE_CLOCK }),
      snapshots: {
        async put(snapshot) {
          stored.set(snapshot.id, snapshot);
        },
        async get(id) {
          return stored.get(id) ?? null;
        },
        async getMany(ids) {
          return ids.flatMap((id) => (stored.has(id) ? [stored.get(id)!] : []));
        },
      },
      runs: { checkpoint: unused, readCheckpoint: unused, finalize: unused },
      clock: { now: () => FIXTURE_CLOCK, monotonicMs: () => 0 },
      audit: {
        sinkId: "audit_claim_fixture",
        async record(event) {
          audit.push(event);
        },
      },
    },
  };
}

function countBy(values: string[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function parseArguments(arguments_: string[]) {
  let mode = "fixture";
  let split: "development" | "calibration" | "test" | "temporal" | "all" = "all";
  let seed = 20_260_910;
  let output: string | undefined;
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Expected --option value, received ${name ?? "end of input"}.`);
    }
    if (name === "--mode") mode = value;
    else if (name === "--split" && (value === "all" || splitIdSchema.safeParse(value).success))
      split = value as typeof split;
    else if (name === "--seed" && Number.isSafeInteger(Number(value)) && Number(value) >= 0)
      seed = Number(value);
    else if (name === "--output") output = value;
    else throw new Error(`Invalid evaluation option: ${name} ${value}`);
  }
  return { mode, split, seed, output };
}
