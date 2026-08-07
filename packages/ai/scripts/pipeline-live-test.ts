import {
  CompositeAiProvider,
  GeminiProvider,
  OllamaProvider,
  verifyText,
} from "../src/index.js";

const provider = new CompositeAiProvider(
  new OllamaProvider({ model: process.env.OLLAMA_MODEL ?? "gemma4:e2b" }),
  new GeminiProvider({
    apiKey: requireEnvironment("GEMINI_API_KEY"),
    embeddingDimensions: 1024,
  }),
);
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
