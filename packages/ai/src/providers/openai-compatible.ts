import type { GenerateOptions, ImageInput, JsonSchema } from "../provider.js";
import { StructuredOutputProvider } from "../provider.js";

export interface OpenAiCompatibleProviderOptions {
  apiKey: string;
  model?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  baseUrl: string;
  providerName?: string;
  extraHeaders?: Record<string, string>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | Array<{ type?: string; text?: string }> };
  }>;
  error?: { message?: string };
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
  error?: { message?: string };
}

/** Adapter for OpenAI's API and services that implement its HTTP contract. */
export class OpenAiCompatibleProvider extends StructuredOutputProvider {
  protected readonly providerName: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly embeddingModel?: string;
  private readonly embeddingDimensions?: number;
  private readonly baseUrl: string;
  private readonly extraHeaders?: Record<string, string>;

  constructor(options: OpenAiCompatibleProviderOptions) {
    super();
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gpt-4.1-mini";
    this.embeddingModel = options.embeddingModel;
    this.embeddingDimensions = options.embeddingDimensions;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.providerName = options.providerName ?? "OpenAI-compatible provider";
    this.extraHeaders = options.extraHeaders;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.embeddingModel) {
      throw new Error(
        `${this.providerName} needs an embedding model. Set AI_EMBEDDING_MODEL or configure a separate embedding provider.`,
      );
    }

    const response = await this.request<EmbeddingResponse>("embeddings", {
      model: this.embeddingModel,
      input: text,
      ...(this.embeddingDimensions ? { dimensions: this.embeddingDimensions } : {}),
    });
    const embedding = response.data?.[0]?.embedding;

    if (!embedding) throw new Error(`${this.providerName} returned no embedding vector.`);
    return embedding;
  }

  protected async generateRaw(
    prompt: string,
    schema: JsonSchema,
    options?: GenerateOptions,
  ): Promise<string> {
    const response = await this.request<ChatCompletionResponse>("chat/completions", {
      model: options?.model ?? this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: { name: "structured_response", strict: true, schema },
      },
    });
    const content = response.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : content;

    if (!text) throw new Error(`${this.providerName} returned no generated content.`);
    return text;
  }

  protected async generateImageRaw(
    prompt: string,
    image: ImageInput,
    schema: JsonSchema,
    options?: GenerateOptions,
  ): Promise<string> {
    const response = await this.request<ChatCompletionResponse>("chat/completions", {
      model: options?.model ?? this.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: image.data, detail: "high" },
            },
          ],
        },
      ],
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: { name: "structured_response", strict: true, schema },
      },
    });
    const content = response.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : content;
    if (!text) throw new Error(`${this.providerName} returned no generated image analysis.`);
    return text;
  }

  private async request<TResponse>(path: string, body: unknown): Promise<TResponse> {
    const response = await fetch(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as TResponse & {
      error?: { message?: string };
    };

    if (!response.ok || payload.error) {
      throw new Error(
        payload.error?.message ??
          `${this.providerName} request failed with HTTP ${response.status}.`,
      );
    }

    return payload;
  }
}
