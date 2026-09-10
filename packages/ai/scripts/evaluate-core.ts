import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAiProvider, type AiProviderConfig, type AiProviderName } from "../src/index.js";
import { adapterRunSchema, evaluationDatasetSchema, splitIdSchema } from "../evaluation/schemas.js";
import { evaluateRun, runInvariantFixture } from "../evaluation/harness.js";
import { createV1EvaluationAdapter } from "../evaluation/v1-adapter.js";

const cli = parseArguments(process.argv.slice(2));
const datasetPath = resolve(
  cli.dataset ??
    new URL("../evaluation/fixtures/invariants.dataset.json", import.meta.url).pathname,
);
const dataset = evaluationDatasetSchema.parse(JSON.parse(await readFile(datasetPath, "utf8")));
let sourceRun;
let invariantChecks: ReturnType<typeof runInvariantFixture>["checks"] = [];
let fixturePassed: boolean | null = null;

if (cli.mode === "fixture") {
  const fixture = runInvariantFixture(dataset, cli.seed);
  sourceRun = fixture.cleanRun;
  invariantChecks = fixture.checks;
  fixturePassed = fixture.passed;
} else if (cli.mode === "replay") {
  if (!cli.replay) throw new Error("Replay mode requires --replay <path>.");
  sourceRun = adapterRunSchema.parse(JSON.parse(await readFile(resolve(cli.replay), "utf8")));
} else {
  const adapter = createV1EvaluationAdapter(createAiProvider(providerConfiguration()));
  sourceRun = await adapter.evaluate(dataset, {
    mode: "live",
    split: cli.split,
    seed: cli.seed,
  });
}

const baseline = cli.baseline
  ? adapterRunSchema.parse(JSON.parse(await readFile(resolve(cli.baseline), "utf8")))
  : undefined;
const evaluated = evaluateRun(dataset, sourceRun, {
  split: cli.split,
  seed: cli.seed,
  baseline,
});
const empiricalStatuses = collectStatuses(evaluated.metrics);
const empiricalGateStatus = empiricalStatuses.includes("fail")
  ? "fail"
  : empiricalStatuses.includes("pass")
    ? "partial"
    : "not_evaluated";
const gateFailure =
  evaluated.integrityIssues.length > 0 ||
  fixturePassed === false ||
  (cli.mode !== "fixture" && empiricalStatuses.some((status) => status !== "pass"));
const report = {
  reportVersion: "1.0.0",
  generatedAt: new Date().toISOString(),
  mode: cli.mode,
  split: cli.split,
  seed: cli.seed,
  datasetPath,
  adapter: { id: sourceRun.adapterId, version: sourceRun.adapterVersion },
  datasetHash: evaluated.datasetHash,
  datasetCounts: evaluated.datasetCounts,
  integrityIssues: evaluated.integrityIssues,
  invariantFixture: {
    status: fixturePassed === null ? "not_evaluated" : fixturePassed ? "pass" : "fail",
    checks: invariantChecks,
  },
  empiricalGateStatus,
  releaseApproved: false,
  metrics: evaluated.metrics,
  outages: sourceRun.outages,
  notes: [
    "Fixture results are code-smoke evidence, not empirical accuracy.",
    "Synthetic and model-generated labels are excluded from human-gold metrics.",
    "Release remains blocked until the required independently adjudicated corpus exists.",
  ],
};
const output = `${JSON.stringify(report, null, 2)}\n`;
if (cli.output) await writeFile(resolve(cli.output), output, "utf8");
process.stdout.write(output);
if (gateFailure) process.exitCode = 1;

function parseArguments(arguments_: string[]) {
  let mode: "fixture" | "replay" | "live" = "fixture";
  let split: "development" | "calibration" | "test" | "temporal" | "all" = "all";
  let seed = 20_260_910;
  let dataset: string | undefined;
  let replay: string | undefined;
  let baseline: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Expected --option value, received ${name ?? "end of input"}.`);
    }
    if (name === "--mode" && ["fixture", "replay", "live"].includes(value))
      mode = value as typeof mode;
    else if (name === "--split" && (value === "all" || splitIdSchema.safeParse(value).success))
      split = value as typeof split;
    else if (name === "--seed" && Number.isSafeInteger(Number(value)) && Number(value) >= 0)
      seed = Number(value);
    else if (name === "--dataset") dataset = value;
    else if (name === "--replay") replay = value;
    else if (name === "--baseline") baseline = value;
    else if (name === "--output") output = value;
    else throw new Error(`Invalid evaluation option: ${name} ${value}`);
    index += 1;
  }
  return { mode, split, seed, dataset, replay, baseline, output };
}

function collectStatuses(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    key === "status" && typeof item === "string" ? [item] : collectStatuses(item),
  );
}

function providerConfiguration(): AiProviderConfig {
  return {
    provider: providerName(requireEnvironment("AI_PROVIDER")),
    apiKey: requireEnvironment("AI_API_KEY"),
    model: process.env.AI_MODEL,
    baseUrl: process.env.AI_BASE_URL,
    embeddingModel: process.env.AI_EMBEDDING_MODEL,
    embeddingDimensions: 1024,
  };
}

function requireEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live evaluation.`);
  return value;
}

function providerName(value: string): AiProviderName {
  if (["anthropic", "gemini", "openai", "openrouter", "openai-compatible"].includes(value))
    return value as AiProviderName;
  throw new Error(`Unsupported AI_PROVIDER: ${value}`);
}
