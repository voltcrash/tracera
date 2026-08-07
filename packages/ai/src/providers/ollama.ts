import type { GenerateOptions, JsonSchema } from "../provider.js";
import { StructuredOutputProvider } from "../provider.js";

export interface OllamaProviderOptions {
  baseUrl?: string;
  model?: string;
  embeddingModel?: string;
  signal?: AbortSignal;
}

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
  error?: string;
}

/** Local, free Ollama provider. Gemma is the default generation model. */
export class OllamaProvider extends StructuredOutputProvider {
  protected readonly providerName = "Ollama";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly embeddingModel: string;
  private readonly signal?: AbortSignal;

  constructor(options: OllamaProviderOptions = {}) {
    super();
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    // Keep the no-config developer path runnable with the locally installed
    // Gemma model. Deployments can still select another model via OLLAMA_MODEL.
    this.model = options.model ?? "gemma4:e2b";
    // The database's pgvector column is intentionally fixed at 1024 dimensions.
    this.embeddingModel = options.embeddingModel ?? "mxbai-embed-large";
    this.signal = options.signal;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.request<OllamaEmbedResponse>("/api/embed", {
      model: this.embeddingModel,
      input: text,
    });
    const embedding = response.embeddings?.[0];

    if (!embedding) {
      throw new Error("Ollama returned no embedding vector.");
    }

    return embedding;
  }

  protected async generateRaw(
    prompt: string,
    schema: JsonSchema,
    options?: GenerateOptions,
  ): Promise<string> {
    const response = await this.request<OllamaChatResponse>("/api/chat", {
      model: options?.model ?? this.model,
      messages: [
        {
          role: "user",
          content: `${prompt}\n\nReturn only JSON that matches this schema:\n${JSON.stringify(schema)}`,
        },
      ],
      format: schema,
      stream: false,
      options: { temperature: 0 },
    });
    const content = response.message?.content;

    if (!content) {
      throw new Error("Ollama returned no generated content.");
    }

    return content;
  }

  private async request<TResponse>(path: string, body: unknown): Promise<TResponse> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    });
    const payload = (await response.json()) as TResponse & { error?: string };

    if (!response.ok || payload.error) {
      throw new Error(payload.error ?? `Ollama request failed with HTTP ${response.status}.`);
    }

    return payload;
  }
}
