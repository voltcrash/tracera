import type { GenerateOptions, ImageInput, JsonSchema } from "../provider.js";
import { StructuredOutputProvider } from "../provider.js";

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
}

interface GeminiGenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

interface GeminiEmbedResponse {
  embedding?: { values?: number[] };
  error?: { message?: string };
}

/** Gemini API adapter. It can use a Google AI Studio free-tier key when supplied. */
export class GeminiProvider extends StructuredOutputProvider {
  protected readonly providerName = "Gemini";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly embeddingModel: string;
  private readonly embeddingDimensions?: number;

  constructor(options: GeminiProviderOptions) {
    super();
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gemini-2.5-flash";
    this.embeddingModel = options.embeddingModel ?? "gemini-embedding-001";
    this.embeddingDimensions = options.embeddingDimensions;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.request<GeminiEmbedResponse>(
      `models/${this.embeddingModel}:embedContent`,
      {
        model: `models/${this.embeddingModel}`,
        content: { parts: [{ text }] },
        ...(this.embeddingDimensions
          ? {
              // `outputDimensionality` is the currently compatible REST field;
              // `embedContentConfig` keeps the request forward-compatible.
              outputDimensionality: this.embeddingDimensions,
              embedContentConfig: {
                outputDimensionality: this.embeddingDimensions,
              },
            }
          : {}),
      },
    );
    const embedding = response.embedding?.values;

    if (!embedding) {
      throw new Error("Gemini returned no embedding vector.");
    }

    return embedding;
  }

  protected async generateRaw(
    prompt: string,
    schema: JsonSchema,
    options?: GenerateOptions,
  ): Promise<string> {
    const response = await this.request<GeminiGenerateResponse>(
      `models/${options?.model ?? this.model}:generateContent`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: schema,
        },
      },
    );
    const content = response.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("");

    if (!content) {
      throw new Error("Gemini returned no generated content.");
    }

    return content;
  }

  protected async generateImageRaw(
    prompt: string,
    image: ImageInput,
    schema: JsonSchema,
    options?: GenerateOptions,
  ): Promise<string> {
    const response = await this.request<GeminiGenerateResponse>(
      `models/${options?.model ?? this.model}:generateContent`,
      {
        contents: [{ parts: [{ text: prompt }, geminiImagePart(image)] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: schema,
        },
      },
    );
    const content = response.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("");
    if (!content)
      throw new Error("Gemini returned no generated image analysis.");
    return content;
  }

  private async request<TResponse>(
    path: string,
    body: unknown,
  ): Promise<TResponse> {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
      },
    );
    const payload = (await response.json()) as TResponse & {
      error?: { message?: string };
    };

    if (!response.ok || payload.error) {
      throw new Error(
        payload.error?.message ??
          `Gemini request failed with HTTP ${response.status}.`,
      );
    }

    return payload;
  }
}

function geminiImagePart(image: ImageInput) {
  if (/^https?:\/\//i.test(image.data)) {
    return {
      fileData: {
        fileUri: image.data,
        mimeType: image.mimeType ?? "image/jpeg",
      },
    };
  }
  const match = image.data.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match)
    throw new Error(
      "Gemini image input must be a public URL or base64 data URI.",
    );
  return {
    inlineData: { mimeType: image.mimeType ?? match[1], data: match[2] },
  };
}
