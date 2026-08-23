import type { AiRequestOptions, GenerateOptions, ImageInput, JsonSchema } from "../provider.js";
import { StructuredOutputProvider } from "../provider.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

interface AnthropicMessageResponse {
  content?: Array<{ type?: string; input?: unknown }>;
  error?: { message?: string };
}

/** Anthropic Messages API adapter. Anthropic does not offer an embeddings API. */
export class AnthropicProvider extends StructuredOutputProvider {
  protected readonly providerName = "Anthropic";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: AnthropicProviderOptions) {
    super();
    this.apiKey = options.apiKey;
    this.model = options.model ?? "claude-sonnet-4-5";
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
  }

  async embed(_text: string, _options?: AiRequestOptions): Promise<number[]> {
    throw new Error(
      "Anthropic does not provide embeddings. Set AI_EMBEDDING_PROVIDER and its API key/model.",
    );
  }

  protected async generateRaw(
    prompt: string,
    schema: JsonSchema,
    options?: GenerateOptions,
  ): Promise<string> {
    const response = await this.request<AnthropicMessageResponse>(
      "messages",
      {
        model: options?.model ?? this.model,
        max_tokens: 4096,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
        tools: [
          {
            name: "submit_structured_output",
            description: "Return the requested result in the supplied JSON schema.",
            input_schema: schema,
          },
        ],
        tool_choice: { type: "tool", name: "submit_structured_output" },
      },
      options?.signal,
    );
    const input = response.content?.find((block) => block.type === "tool_use")?.input;

    if (input === undefined) throw new Error("Anthropic returned no structured tool response.");
    return JSON.stringify(input);
  }

  protected async generateImageRaw(
    prompt: string,
    image: ImageInput,
    schema: JsonSchema,
    options?: GenerateOptions,
  ): Promise<string> {
    const response = await this.request<AnthropicMessageResponse>(
      "messages",
      {
        model: options?.model ?? this.model,
        max_tokens: 4096,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [anthropicImageBlock(image), { type: "text", text: prompt }],
          },
        ],
        tools: [
          {
            name: "submit_structured_output",
            description: "Return the requested result in the supplied JSON schema.",
            input_schema: schema,
          },
        ],
        tool_choice: { type: "tool", name: "submit_structured_output" },
      },
      options?.signal,
    );
    const input = response.content?.find((block) => block.type === "tool_use")?.input;
    if (input === undefined) throw new Error("Anthropic returned no structured image analysis.");
    return JSON.stringify(input);
  }

  private async request<TResponse>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<TResponse> {
    const response = await fetch(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await response.json()) as TResponse & {
      error?: { message?: string };
    };

    if (!response.ok || payload.error) {
      throw new Error(
        payload.error?.message ?? `Anthropic request failed with HTTP ${response.status}.`,
      );
    }

    return payload;
  }
}

function anthropicImageBlock(image: ImageInput) {
  if (/^https?:\/\//i.test(image.data)) {
    return { type: "image", source: { type: "url", url: image.data } };
  }
  const match = image.data.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) throw new Error("Anthropic image input must be a public URL or base64 data URI.");
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: image.mimeType ?? match[1],
      data: match[2],
    },
  };
}
