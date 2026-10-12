import { safeFetch } from "./safe-fetch";

export class ProviderRequestError extends Error {
  constructor(
    readonly provider: string,
    readonly status?: number,
  ) {
    super(`${provider} request failed${status === undefined ? "." : ` with HTTP ${status}.`}`);
    this.name = "ProviderRequestError";
  }
}

export async function requestProviderJson<T>(
  provider: string,
  url: string,
  init: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await safeFetch(url, init);
  } catch {
    if (init.signal?.aborted)
      throw new DOMException("The provider request was aborted.", "AbortError");
    throw new ProviderRequestError(provider);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderRequestError(provider, response.status);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (init.signal?.aborted)
      throw new DOMException("The provider request was aborted.", "AbortError");
    throw new ProviderRequestError(provider, response.status);
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    ("error" in payload && payload.error)
  ) {
    throw new ProviderRequestError(provider, response.status);
  }
  return payload as T;
}
