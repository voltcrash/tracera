import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAiCompatibleProvider,
  StructuredOutputProvider,
  type GenerateOptions,
  type ImageInput,
  type JsonSchema,
  type StructuredOutputAttempt,
} from "../src/index.js";

const textSchema = z.object({ text: z.string().min(1) });

test("structured output retries invalid text and image responses once", async () => {
  const provider = new QueueProvider(
    ["not-json", '{"text":"repaired text"}'],
    ['{"wrong":true}', '{"text":"repaired image"}'],
  );
  const textAttempts: StructuredOutputAttempt[] = [];
  const imageAttempts: StructuredOutputAttempt[] = [];

  const generated = await provider.generate("prompt", textSchema, {
    onStructuredOutputAttempt: (attempt) => textAttempts.push(attempt),
  });
  const image = await provider.generateFromImage(
    "ocr",
    { data: "data:image/png;base64,aGVsbG8=", mimeType: "image/png" },
    textSchema,
    { onStructuredOutputAttempt: (attempt) => imageAttempts.push(attempt) },
  );

  assert.equal(generated.text, "repaired text");
  assert.equal(image.text, "repaired image");
  assert.deepEqual(
    textAttempts.map(({ attempt, valid }) => ({ attempt, valid })),
    [
      { attempt: 1, valid: false },
      { attempt: 2, valid: true },
    ],
  );
  assert.equal(imageAttempts[0]?.valid, false);
  assert.equal(imageAttempts[1]?.valid, true);
});

test("OpenAI-compatible image generation sends a real image content part", async () => {
  let requestBody: unknown;
  await withMockFetch(
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({
        choices: [{ message: { content: '{"text":"OpenAI OCR"}' } }],
      });
    },
    async () => {
      const provider = new OpenAiCompatibleProvider({
        apiKey: "test",
        baseUrl: "https://provider.example/v1",
        model: "vision-model",
      });
      const result = await provider.generateFromImage(
        "Transcribe",
        { data: "data:image/png;base64,aGVsbG8=", mimeType: "image/png" },
        textSchema,
      );
      assert.equal(result.text, "OpenAI OCR");
    },
  );

  const content = (
    requestBody as {
      messages: Array<{
        content: Array<{ type: string; image_url?: { url: string } }>;
      }>;
    }
  ).messages[0]?.content;
  assert.equal(content?.[1]?.type, "image_url");
  assert.equal(content?.[1]?.image_url?.url, "data:image/png;base64,aGVsbG8=");
});

test("Gemini image generation uses inlineData for uploaded images", async () => {
  let requestBody: unknown;
  await withMockFetch(
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({
        candidates: [
          { content: { parts: [{ text: '{"text":"Gemini OCR"}' }] } },
        ],
      });
    },
    async () => {
      const provider = new GeminiProvider({
        apiKey: "test",
        model: "vision-model",
      });
      const result = await provider.generateFromImage(
        "Transcribe",
        { data: "data:image/jpeg;base64,aGVsbG8=", mimeType: "image/jpeg" },
        textSchema,
      );
      assert.equal(result.text, "Gemini OCR");
    },
  );

  const parts = (
    requestBody as {
      contents: Array<{
        parts: Array<{ inlineData?: { mimeType: string; data: string } }>;
      }>;
    }
  ).contents[0]?.parts;
  assert.deepEqual(parts?.[1]?.inlineData, {
    mimeType: "image/jpeg",
    data: "aGVsbG8=",
  });
});

test("Anthropic image generation sends base64 media through a tool response", async () => {
  let requestBody: unknown;
  await withMockFetch(
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({
        content: [{ type: "tool_use", input: { text: "Anthropic OCR" } }],
      });
    },
    async () => {
      const provider = new AnthropicProvider({
        apiKey: "test",
        model: "vision-model",
      });
      const result = await provider.generateFromImage(
        "Transcribe",
        { data: "data:image/webp;base64,aGVsbG8=", mimeType: "image/webp" },
        textSchema,
      );
      assert.equal(result.text, "Anthropic OCR");
    },
  );

  const source = (
    requestBody as {
      messages: Array<{
        content: Array<{
          source?: { type: string; media_type: string; data: string };
        }>;
      }>;
    }
  ).messages[0]?.content[0]?.source;
  assert.deepEqual(source, {
    type: "base64",
    media_type: "image/webp",
    data: "aGVsbG8=",
  });
});

class QueueProvider extends StructuredOutputProvider {
  protected readonly providerName = "test provider";

  constructor(
    private readonly textResponses: string[],
    private readonly imageResponses: string[],
  ) {
    super();
  }

  async embed() {
    return [];
  }

  protected async generateRaw(
    _prompt: string,
    _schema: JsonSchema,
    _options?: GenerateOptions,
  ) {
    return this.textResponses.shift() ?? "";
  }

  protected async generateImageRaw(
    _prompt: string,
    _image: ImageInput,
    _schema: JsonSchema,
    _options?: GenerateOptions,
  ) {
    return this.imageResponses.shift() ?? "";
  }
}

async function withMockFetch(mock: typeof fetch, run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
