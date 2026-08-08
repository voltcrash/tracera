import {
  createAiProvider,
  verifyText,
  type AiProviderConfig,
  type AiProviderName,
} from "../src/index.js";

const provider = createAiProvider(providerConfiguration());
const factCheckApiKey = requireEnvironment("GOOGLE_FACT_CHECK_API_KEY");

const articles = [
  {
    label: "true",
    source: "NASA Science: What is the greenhouse effect?",
    text: "NASA explains that rising carbon dioxide levels trap extra heat near Earth’s surface and contribute to rising temperatures. The article says this increase has occurred consistently for decades.",
  },
  {
    label: "false",
    source: "Viral flat-Earth claim checked by multiple outlets",
    text: "A viral article claims that the Earth is flat and that all satellite photographs of Earth are fabricated by NASA.",
  },
  {
    label: "misleading",
    source: "Climate article with unsupported framing",
    text: "An article says climate records show warming, then claims without evidence that every recent extreme-weather event proves a coordinated global deception. It calls scientists who disagree traitors.",
  },
];

for (const article of articles) {
  const result = await verifyText(article.text, { provider, factCheckApiKey });
  console.log(
    JSON.stringify(
      {
        label: article.label,
        source: article.source,
        claims: result.claims.map((claim) => ({
          text: claim.claim.claimText,
          type: claim.claim.claimType,
          checkability: claim.claim.checkability,
          verdict: claim.verdict,
          confidence: claim.confidence,
          evidenceQuality: claim.evidenceQuality,
          sources: claim.supportingSources.length + claim.contradictingSources.length,
        })),
        traceraScore: result.score,
      },
      null,
      2,
    ),
  );
}

function requireEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the live pipeline test.`);
  return value;
}

function providerConfiguration(): AiProviderConfig {
  const apiKey = requireEnvironment("AI_API_KEY");
  const embeddingProvider = process.env.AI_EMBEDDING_PROVIDER
    ? providerName(process.env.AI_EMBEDDING_PROVIDER)
    : undefined;
  const embeddingModel = process.env.AI_EMBEDDING_MODEL;
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
            model: embeddingModel,
            baseUrl: process.env.AI_EMBEDDING_BASE_URL,
            dimensions: 1024,
          },
        }
      : { embeddingModel, embeddingDimensions: 1024 }),
  };
}

function providerName(value: string): AiProviderName {
  if (
    value === "anthropic" ||
    value === "gemini" ||
    value === "openai" ||
    value === "openrouter" ||
    value === "openai-compatible"
  ) {
    return value;
  }
  throw new Error(`Unsupported AI_PROVIDER: ${value}`);
}
