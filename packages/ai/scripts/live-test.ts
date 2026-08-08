import { createAiProvider } from "../src/index.js";
import { z } from "zod";

const schema = z.object({
  greeting: z.literal("hello"),
  answer: z.literal(42),
});

const provider = createAiProvider({
  provider: "gemini",
  apiKey: requireEnvironment("GEMINI_API_KEY"),
  model: process.env.GEMINI_MODEL,
});

const result = await provider.generate(
  'Return the exact JSON object {"greeting":"hello","answer":42}.',
  schema,
);

console.log(JSON.stringify({ provider: "gemini", result }, null, 2));

function requireEnvironment(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}
