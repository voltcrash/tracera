import type { ResolvedAddress } from "./safe-fetch-transport";

export function fetchValidatedTarget(
  url: URL,
  init: RequestInit,
  body: Buffer | undefined,
  _addresses: ResolvedAddress[],
) {
  return globalThis.fetch(url, {
    ...init,
    body: body as unknown as BodyInit | undefined,
    redirect: "manual",
  });
}
