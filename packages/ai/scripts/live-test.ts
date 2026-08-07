import { createAiProvider } from "../src/index.js";
import { z } from "zod";

const providerName = process.env.AI_PROVIDER ?? "ollama";
const schema = z.object({
  greeting: z.literal("hello"),
  answer: z.literal(42),
});

const provider =
  providerName === "gemini"
    ? createAiProvider({
        provider: "gemini",
        apiKey: requireEnvironment("GEMINI_API_KEY"),
        model: process.env.GEMINI_MODEL,
      })
    : providerName === "ollama"
      ? createAiProvider({
          provider: "ollama",
          baseUrl: process.env.OLLAMA_BASE_URL,
          model: process.env.OLLAMA_MODEL ?? "gemma2:9b",
        })
      : (() => {
          throw new Error("AI_PROVIDER must be either 'ollama' or 'gemini'.");
        })();

const result = await provider.generate(
  'Return the exact JSON object {"greeting":"hello","answer":42}.',
  schema,
);

console.log(JSON.stringify({ provider: providerName, result }, null, 2));

function requireEnvironment(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required when AI_PROVIDER=gemini.`);
  }

  return value;
}
