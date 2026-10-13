import { createAiProvider } from "./create-provider";
import { personalProviderConfig, type ProviderKeyInput } from "./provider-key-input";
import { ProviderRequestError, requestProviderJson } from "./provider-request";
import { assertPublicHttpUrl, type HostAddressResolver } from "./safe-fetch";

export class ProviderKeyRejectedError extends Error {
  constructor() {
    super("Your key was rejected. Update your provider key in Settings and try again.");
    this.name = "ProviderKeyRejectedError";
  }
}
export class ProviderKeyVerificationError extends Error {
  constructor() {
    super(
      "Could not verify your provider and models. Check access, billing, and model names, then try again.",
    );
    this.name = "ProviderKeyVerificationError";
  }
}
export function isProviderKeyRejection(error: unknown) {
  return error instanceof ProviderRequestError && (error.status === 401 || error.status === 403);
}

export async function verifyProviderKey(
  input: ProviderKeyInput,
  options: { resolveHostAddresses?: HostAddressResolver } = {},
) {
  try {
    for (const url of [input.baseUrl, input.embeddingBaseUrl])
      if (url) await assertPublicHttpUrl(url, options);
    const signal = AbortSignal.timeout(15_000);
    await verifyGeneration(input, signal);
    const vector = await createAiProvider(personalProviderConfig(input, input)).embed(
      "Key verification.",
      { signal },
    );
    if (vector.length !== 1024 || vector.some((value) => !Number.isFinite(value)))
      throw new ProviderKeyVerificationError();
  } catch (error) {
    if (isProviderKeyRejection(error)) throw new ProviderKeyRejectedError();
    throw new ProviderKeyVerificationError();
  }
}

async function verifyGeneration(input: ProviderKeyInput, signal: AbortSignal) {
  let url: string;
  let headers: Record<string, string>;
  let body: unknown;
  let responseField: string;
  if (input.provider === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`;
    headers = { "x-goog-api-key": input.apiKey };
    body = {
      contents: [{ parts: [{ text: "Reply OK." }] }],
      generationConfig: { maxOutputTokens: 1 },
    };
    responseField = "candidates";
  } else if (input.provider === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    headers = { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" };
    body = {
      model: input.model,
      max_tokens: 1,
      messages: [{ role: "user", content: "Reply OK." }],
    };
    responseField = "content";
  } else {
    const baseUrl =
      input.provider === "openai"
        ? "https://api.openai.com/v1"
        : input.provider === "openrouter"
          ? "https://openrouter.ai/api/v1"
          : input.baseUrl!;
    url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    headers = { authorization: `Bearer ${input.apiKey}` };
    body = {
      model: input.model,
      messages: [{ role: "user", content: "Reply OK." }],
      ...(input.provider === "openai" ? { max_completion_tokens: 1 } : { max_tokens: 1 }),
    };
    responseField = "choices";
  }
  const response = await requestProviderJson<Record<string, unknown>>("Key verification", url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!Array.isArray(response[responseField])) throw new ProviderKeyVerificationError();
}
