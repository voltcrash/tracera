import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  createAiProvider,
  extractClaims,
  scoreClaim,
  type AiProviderConfig,
  type AiProviderName,
  type ExtractedClaim,
  type StructuredOutputAttempt,
} from "../src/index.js";

const evidenceSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().url(),
  snippet: z.string(),
  credibility: z.number().min(0).max(1),
});
const caseSchema = z.object({
  id: z.string(),
  label: z.enum(["true", "false", "misleading"]),
  articleUrl: z.string().url(),
  articleText: z.string().min(30),
  expectedVerdict: z.enum([
    "supported",
    "contradicted",
    "misleading",
    "mixed",
    "unverified",
  ]),
  expectedTerms: z.array(z.string()).min(2),
  evidence: z.array(evidenceSchema).min(1),
});
const datasetSchema = z.array(caseSchema).min(5).max(10);
type EvaluationCase = z.infer<typeof caseSchema>;

const datasetPath = resolve(
  process.argv[2] ??
    new URL("../evaluation/model-validation.json", import.meta.url).pathname,
);
const dataset = datasetSchema.parse(
  JSON.parse(await readFile(datasetPath, "utf8")),
);
const provider = createAiProvider(providerConfiguration());
const results = [];

for (const evaluation of dataset) {
  results.push(await evaluateCase(evaluation));
}

const report = buildReport(results);
console.log(JSON.stringify(report, null, 2));
if (!report.approved) process.exitCode = 1;

async function evaluateCase(evaluation: EvaluationCase) {
  const attempts: Array<StructuredOutputAttempt & { stage: string }> = [];
  const prompts: Array<{ stage: string; prompt: string }> = [];
  const audit = {
    onPrompt: (record: { stage: string; prompt: string }) =>
      prompts.push(record),
    onStructuredOutputAttempt: (
      record: StructuredOutputAttempt & { stage: string },
    ) => attempts.push(record),
  };

  const startedAt = performance.now();
  const extractionStartedAt = performance.now();
  const claims = await extractClaims(provider, evaluation.articleText, audit);
  const extractionMs = performance.now() - extractionStartedAt;
  const selectedClaim = selectClaim(claims, evaluation.expectedTerms);
  const evidence = evaluation.evidence.map((source) => ({
    ...source,
    type: "web_search" as const,
    sourceDomain: new URL(source.url).hostname.replace(/^www\./, ""),
    similarity: 1,
  }));

  const verdictStartedAt = performance.now();
  const verdict = selectedClaim
    ? await scoreClaim(provider, selectedClaim, evidence, audit)
    : undefined;
  const verdictMs = performance.now() - verdictStartedAt;
  const extractionCoverage = selectedClaim
    ? termCoverage(selectedClaim.claimText, evaluation.expectedTerms)
    : 0;
  const usedSources = verdict
    ? [...verdict.supportingSources, ...verdict.contradictingSources]
    : [];
  const promptCharacters = prompts.reduce(
    (total, record) => total + record.prompt.length,
    0,
  );
  const outputCharacters = JSON.stringify({ claims, verdict }).length;

  return {
    id: evaluation.id,
    label: evaluation.label,
    articleUrl: evaluation.articleUrl,
    extractedClaims: claims.map((claim) => claim.claimText),
    selectedClaim: selectedClaim?.claimText ?? null,
    extractionCoverage: round(extractionCoverage),
    extractionPass: extractionCoverage >= 0.67,
    atomicityPass: claims.length > 0 && claims.every(isPlausiblyAtomic),
    expectedVerdict: evaluation.expectedVerdict,
    actualVerdict: verdict?.verdict ?? null,
    verdictPass: verdict?.verdict === evaluation.expectedVerdict,
    evidenceUsePass: Boolean(verdict && usedSources.length > 0),
    reasoning: verdict?.reasoning ?? [],
    structuredOutput: {
      attempts,
      invalidAttempts: attempts.filter((attempt) => !attempt.valid).length,
      firstAttemptPass: stagesPassedFirstAttempt(attempts),
    },
    latencyMs: {
      extraction: round(extractionMs),
      verdict: round(verdictMs),
      total: round(performance.now() - startedAt),
    },
    estimatedTokens: {
      input: Math.ceil(promptCharacters / 4),
      output: Math.ceil(outputCharacters / 4),
    },
  };
}

function buildReport(results: Awaited<ReturnType<typeof evaluateCase>>[]) {
  const extractionRate = passRate(results, "extractionPass");
  const atomicityRate = passRate(results, "atomicityPass");
  const verdictRate = passRate(results, "verdictPass");
  const evidenceUseRate = passRate(results, "evidenceUsePass");
  const firstAttemptSchemaRate =
    results.filter((result) => result.structuredOutput.firstAttemptPass)
      .length / results.length;
  const latencyValues = results
    .map((result) => result.latencyMs.total)
    .sort((left, right) => left - right);
  const inputTokens = sum(
    results.map((result) => result.estimatedTokens.input),
  );
  const outputTokens = sum(
    results.map((result) => result.estimatedTokens.output),
  );
  const estimatedCostUsd = estimateCost(inputTokens, outputTokens);
  const thresholds = {
    extractionRate: environmentNumber("EVAL_MIN_EXTRACTION_RATE", 0.8),
    atomicityRate: environmentNumber("EVAL_MIN_ATOMICITY_RATE", 0.8),
    verdictRate: environmentNumber("EVAL_MIN_VERDICT_RATE", 0.8),
    evidenceUseRate: environmentNumber("EVAL_MIN_EVIDENCE_USE_RATE", 0.8),
    firstAttemptSchemaRate: environmentNumber("EVAL_MIN_SCHEMA_RATE", 0.95),
    p95LatencyMs: environmentNumber("EVAL_MAX_P95_LATENCY_MS", 60_000),
  };
  const metrics = {
    cases: results.length,
    extractionRate: round(extractionRate),
    atomicityRate: round(atomicityRate),
    verdictRate: round(verdictRate),
    evidenceUseRate: round(evidenceUseRate),
    firstAttemptSchemaRate: round(firstAttemptSchemaRate),
    p50LatencyMs: percentile(latencyValues, 0.5),
    p95LatencyMs: percentile(latencyValues, 0.95),
    estimatedTokens: { input: inputTokens, output: outputTokens },
    estimatedCostUsd,
  };
  const approved =
    metrics.cases >= 5 &&
    extractionRate >= thresholds.extractionRate &&
    atomicityRate >= thresholds.atomicityRate &&
    verdictRate >= thresholds.verdictRate &&
    evidenceUseRate >= thresholds.evidenceUseRate &&
    firstAttemptSchemaRate >= thresholds.firstAttemptSchemaRate &&
    metrics.p95LatencyMs <= thresholds.p95LatencyMs;
  const invalidFirstAttempts = results
    .flatMap((result) => result.structuredOutput.attempts)
    .filter((attempt) => attempt.attempt === 1 && !attempt.valid).length;

  return {
    approved,
    evaluatedAt: new Date().toISOString(),
    datasetPath,
    provider: process.env.AI_PROVIDER,
    model: process.env.AI_MODEL,
    thresholds,
    metrics,
    recommendedRetryAttempts: invalidFirstAttempts > 0 ? 2 : 1,
    notes: [
      "Token counts and cost are estimates because provider usage metadata is not exposed by the shared adapter.",
      "A human reviewer must still inspect extractedClaims and reasoning before production approval.",
    ],
    results,
  };
}

function selectClaim(claims: ExtractedClaim[], expectedTerms: string[]) {
  return [...claims].sort(
    (left, right) =>
      termCoverage(right.claimText, expectedTerms) -
      termCoverage(left.claimText, expectedTerms),
  )[0];
}

function termCoverage(text: string, terms: string[]) {
  const normalized = text.toLocaleLowerCase();
  return (
    terms.filter((term) => normalized.includes(term.toLocaleLowerCase()))
      .length / terms.length
  );
}

function isPlausiblyAtomic(claim: ExtractedClaim) {
  const conjunctions =
    claim.claimText.match(/\b(and|but|while|whereas)\b/gi)?.length ?? 0;
  return (
    claim.claimText.length <= 240 &&
    !claim.claimText.includes(";") &&
    conjunctions <= 1
  );
}

function stagesPassedFirstAttempt(
  attempts: Array<StructuredOutputAttempt & { stage: string }>,
) {
  const stages = new Set(attempts.map((attempt) => attempt.stage));
  return [...stages].every((stage) =>
    attempts.some(
      (attempt) =>
        attempt.stage === stage && attempt.attempt === 1 && attempt.valid,
    ),
  );
}

function passRate<
  T extends
    | "extractionPass"
    | "atomicityPass"
    | "verdictPass"
    | "evidenceUsePass",
>(values: Array<Record<T, boolean>>, key: T) {
  return values.filter((value) => value[key]).length / values.length;
}

function percentile(values: number[], quantile: number) {
  return values[Math.max(0, Math.ceil(values.length * quantile) - 1)] ?? 0;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function estimateCost(inputTokens: number, outputTokens: number) {
  const inputRate = Number(process.env.EVAL_INPUT_USD_PER_MILLION_TOKENS);
  const outputRate = Number(process.env.EVAL_OUTPUT_USD_PER_MILLION_TOKENS);
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate)) return null;
  return round(
    (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000,
  );
}

function round(value: number) {
  return Number(value.toFixed(4));
}

function environmentNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function requireEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for model validation.`);
  return value;
}

function providerConfiguration(): AiProviderConfig {
  const apiKey = requireEnvironment("AI_API_KEY");
  const embeddingProvider = process.env.AI_EMBEDDING_PROVIDER
    ? providerName(process.env.AI_EMBEDDING_PROVIDER)
    : undefined;
  return {
    provider: providerName(requireEnvironment("AI_PROVIDER")),
    apiKey,
    model: process.env.AI_MODEL,
    baseUrl: process.env.AI_BASE_URL,
    ...(embeddingProvider
      ? {
          embedding: {
            provider: embeddingProvider,
            apiKey: process.env.AI_EMBEDDING_API_KEY ?? apiKey,
            model: process.env.AI_EMBEDDING_MODEL,
            baseUrl: process.env.AI_EMBEDDING_BASE_URL,
            dimensions: 1024,
          },
        }
      : {
          embeddingModel: process.env.AI_EMBEDDING_MODEL,
          embeddingDimensions: 1024,
        }),
  };
}

function providerName(value: string): AiProviderName {
  if (
    [
      "anthropic",
      "gemini",
      "openai",
      "openrouter",
      "openai-compatible",
    ].includes(value)
  ) {
    return value as AiProviderName;
  }
  throw new Error(`Unsupported AI_PROVIDER: ${value}`);
}
