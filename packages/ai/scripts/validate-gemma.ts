import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  OllamaProvider,
  extractClaims,
  scoreClaim,
  type EvidenceSource,
  type StructuredOutputAttempt,
  type Verdict,
} from "../src/index.js";

interface ValidationCase {
  id: string;
  expectedVerdicts: Verdict[];
  articleUrl: string;
  text: string;
  evidence: EvidenceSource[];
}

interface CaseReport {
  id: string;
  articleUrl: string;
  expectedVerdicts: Verdict[];
  attempts: StructuredOutputAttempt[];
  claimCount?: number;
  groundedClaims?: boolean;
  verdicts?: Array<{
    verdict: Verdict;
    confidence: number;
    reasoning: string[];
    sourceConflict: boolean;
  }>;
  acceptedVerdict?: boolean;
  error?: string;
  durationMs: number;
}

/**
 * Repeatable Step 0 evaluation. The excerpts are deliberately short
 * paraphrases of published reporting/primary-source material, while the URLs
 * preserve the material that a human reviewer must consult before accepting a
 * model for production use. This is an evaluation harness, not fact evidence
 * used by the product pipeline.
 */
const cases: ValidationCase[] = [
  {
    id: "co2-greenhouse-effect",
    expectedVerdicts: ["supported"],
    articleUrl: "https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/",
    text: "NASA explains that carbon dioxide is a greenhouse gas. It says higher carbon dioxide concentrations retain additional heat in Earth's atmosphere.",
    evidence: [
      source("nasa-greenhouse", "NASA: What is the greenhouse effect?", "NASA", "science.nasa.gov", "NASA describes carbon dioxide as a greenhouse gas that traps heat in the atmosphere.", "https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/"),
      source("noaa-greenhouse", "NOAA Climate: greenhouse gases", "NOAA", "climate.gov", "NOAA explains that carbon dioxide absorbs and re-emits infrared energy, warming the climate system.", "https://www.climate.gov/news-features/understanding-climate/climate-change-atmospheric-carbon-dioxide"),
    ],
  },
  {
    id: "flat-earth-conspiracy",
    expectedVerdicts: ["contradicted", "misleading"],
    articleUrl: "https://science.nasa.gov/earth/facts/",
    text: "A viral post says Earth is flat and that every satellite image is fabricated by NASA.",
    evidence: [
      source("nasa-earth", "NASA: Earth facts", "NASA", "science.nasa.gov", "NASA documents Earth as an oblate spheroid and publishes observations from multiple missions.", "https://science.nasa.gov/earth/facts/"),
      source("esa-earth", "ESA: observing Earth from space", "European Space Agency", "esa.int", "ESA operates independent Earth-observation missions and publishes their data and imagery.", "https://www.esa.int/Applications/Observing_the_Earth"),
    ],
  },
  {
    id: "vaccine-transmission-absolute",
    expectedVerdicts: ["contradicted", "misleading"],
    articleUrl: "https://www.who.int/news-room/questions-and-answers/item/coronavirus-disease-(covid-19)-vaccines",
    text: "An article says vaccination always prevents infection, so a vaccinated person cannot transmit a virus.",
    evidence: [
      source("who-vaccines", "WHO: COVID-19 vaccines questions and answers", "World Health Organization", "who.int", "WHO says vaccines reduce severe disease and transmission risk but breakthrough infections can occur.", "https://www.who.int/news-room/questions-and-answers/item/coronavirus-disease-(covid-19)-vaccines"),
      source("cdc-vaccines", "CDC: Benefits of COVID-19 vaccination", "CDC", "cdc.gov", "CDC notes vaccination lowers risk and that vaccinated people can still become infected.", "https://www.cdc.gov/covid/vaccines/benefits.html"),
    ],
  },
  {
    id: "coffee-longevity-guarantee",
    expectedVerdicts: ["misleading", "unverified", "contradicted"],
    articleUrl: "https://www.hsph.harvard.edu/news/hsph-in-the-news/is-coffee-good-or-bad-for-your-health/",
    text: "A health article says coffee is healthy and guarantees a longer life for everyone who drinks it.",
    evidence: [
      source("harvard-coffee", "Harvard: Is coffee good or bad for your health?", "Harvard T.H. Chan School of Public Health", "hsph.harvard.edu", "Harvard describes observational associations and says individual effects vary; it does not claim a guaranteed longevity benefit.", "https://www.hsph.harvard.edu/news/hsph-in-the-news/is-coffee-good-or-bad-for-your-health/"),
      source("fda-caffeine", "FDA: Spilling the beans on caffeine", "FDA", "fda.gov", "FDA notes caffeine affects people differently and excessive intake can cause adverse effects.", "https://www.fda.gov/consumers/consumer-updates/spilling-beans-how-much-caffeine-too-much"),
    ],
  },
  {
    id: "climate-framing",
    expectedVerdicts: ["unverified", "misleading"],
    articleUrl: "https://www.ipcc.ch/report/ar6/syr/",
    text: "A commentary says traitor scientists created a shocking climate hoax to control the public.",
    evidence: [
      source("ipcc-synthesis", "IPCC AR6 Synthesis Report", "IPCC", "ipcc.ch", "The IPCC synthesis reports evidence for human influence on warming and does not support a coordinated-hoax allegation.", "https://www.ipcc.ch/report/ar6/syr/"),
      source("nasa-climate", "NASA: Evidence for climate change", "NASA", "climate.nasa.gov", "NASA summarizes multiple independent measurements showing a warming climate.", "https://climate.nasa.gov/evidence/"),
    ],
  },
];

const model = process.env.OLLAMA_MODEL ?? "gemma4:e2b";
const provider = new OllamaProvider({ model });
const report: CaseReport[] = [];

for (const testCase of cases) {
  const startedAt = Date.now();
  const attempts: StructuredOutputAttempt[] = [];
  try {
    const claims = await extractClaimsWithTelemetry(provider, testCase.text, attempts);
    const verdicts = [];
    for (const claim of claims) {
      verdicts.push(await scoreClaimWithTelemetry(provider, claim, testCase.evidence, attempts));
    }
    report.push({
      id: testCase.id,
      articleUrl: testCase.articleUrl,
      expectedVerdicts: testCase.expectedVerdicts,
      claimCount: claims.length,
      groundedClaims: claims.every((claim) => claimIsGrounded(claim.claimText, testCase.text)),
      verdicts: verdicts.map(({ verdict, confidence, reasoning, sourceConflict }) => ({ verdict, confidence, reasoning, sourceConflict })),
      attempts,
      acceptedVerdict: verdicts.every((item) => testCase.expectedVerdicts.includes(item.verdict)),
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    report.push({
      id: testCase.id,
      articleUrl: testCase.articleUrl,
      expectedVerdicts: testCase.expectedVerdicts,
      attempts,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
  }
}

const structuredAttempts = report.flatMap((item) => item.attempts);
const result = {
  model,
  testedAt: new Date().toISOString(),
  instructions: {
    template: "Gemma 4 Ollama template uses a single Prompt field; provider folds instructions into the user message.",
    acceptance: "Review every result manually. Do not promote a model based only on these summary fields.",
  },
  summary: {
    cases: cases.length,
    completed: report.filter((item) => !item.error).length,
    schemaConformanceBeforeRetry: ratio(
      structuredAttempts.filter((item) => item.attempt === 1 && item.valid).length,
      structuredAttempts.filter((item) => item.attempt === 1).length,
    ),
    schemaConformanceAfterRetry: ratio(
      structuredAttempts.filter((item) => item.valid).length,
      structuredAttempts.filter((item) => item.attempt === 1).length,
    ),
    retryRate: ratio(
      structuredAttempts.filter((item) => item.attempt === 2).length,
      structuredAttempts.filter((item) => item.attempt === 1).length,
    ),
    atomicityPassRate: ratio(report.filter((item) => (item.claimCount ?? 0) >= 1 && (item.claimCount ?? 0) <= 3 && item.groundedClaims).length, cases.length),
    expectedVerdictRate: ratio(report.filter((item) => item.acceptedVerdict).length, cases.length),
  },
  report,
};

const outputPath = process.env.GEMMA_VALIDATION_OUTPUT;
if (outputPath) {
  const absolutePath = resolve(outputPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result, null, 2));

function source(id: string, title: string, publisher: string, sourceDomain: string, snippet: string, url: string): EvidenceSource {
  return { id, type: "web_search", title, publisher, sourceDomain, snippet, url, publishedAt: "2025-01-01T00:00:00.000Z", credibility: 0.9, similarity: 0.9 };
}

async function extractClaimsWithTelemetry(currentProvider: OllamaProvider, text: string, attempts: StructuredOutputAttempt[]) {
  // extractClaims keeps the production prompt intact. The lightweight proxy
  // exposes its structured-output attempts without changing pipeline code.
  return extractClaims(telemetryProvider(currentProvider, attempts), text);
}

async function scoreClaimWithTelemetry(currentProvider: OllamaProvider, claim: Awaited<ReturnType<typeof extractClaims>>[number], evidence: EvidenceSource[], attempts: StructuredOutputAttempt[]) {
  return scoreClaim(telemetryProvider(currentProvider, attempts), claim, evidence);
}

function telemetryProvider(currentProvider: OllamaProvider, attempts: StructuredOutputAttempt[]) {
  return {
    embed: (text: string) => currentProvider.embed(text),
    generate: <TSchema extends import("zod").z.ZodType>(prompt: string, schema: TSchema) => currentProvider.generate(prompt, schema, { onStructuredOutputAttempt: (attempt) => attempts.push(attempt) }),
  };
}

function claimIsGrounded(claim: string, text: string) {
  const inputTerms = new Set(terms(text));
  const claimTerms = terms(claim);
  return claimTerms.length > 0 && claimTerms.filter((term) => inputTerms.has(term)).length / claimTerms.length >= 0.6;
}

function terms(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((word) => word.length >= 3);
}

function ratio(numerator: number, denominator: number) {
  return denominator ? Number((numerator / denominator).toFixed(3)) : 0;
}
