import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type { ResolvedAddress } from "./safe-fetch-transport";

export function fetchValidatedTarget(
  url: URL,
  init: RequestInit,
  body: Buffer | undefined,
  addresses: ResolvedAddress[],
) {
  return new Promise<Response>((resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    let responseStarted = false;
    let responseStream: IncomingMessage | undefined;
    let request!: ReturnType<typeof httpRequest>;
    const detachAbort = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      const reason = abortError(signal);
      responseStream?.destroy(reason);
      request.destroy(reason);
      if (!responseStarted) reject(signal?.reason ?? reason);
    };
    const onResponse = (incoming: IncomingMessage) => {
      responseStarted = true;
      responseStream = incoming;
      incoming.once("close", detachAbort);
      const bodyStream = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(
        new Response(bodyStream, {
          status: incoming.statusCode ?? 500,
          statusText: incoming.statusMessage ?? "",
          headers: responseHeaders(incoming),
        }),
      );
    };
    const requestOptions = {
      protocol: url.protocol,
      hostname: stripBrackets(url.hostname),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: String(init.method ?? "GET").toUpperCase(),
      headers: requestHeaders(init.headers),
      lookup: pinnedLookup(addresses),
      agent: false,
    };

    try {
      request =
        url.protocol === "https:"
          ? httpsRequest(
              {
                ...requestOptions,
                ...(isIP(requestOptions.hostname) === 0
                  ? { servername: requestOptions.hostname }
                  : {}),
              } as HttpsRequestOptions,
              onResponse,
            )
          : httpRequest(requestOptions as RequestOptions, onResponse);
    } catch (error) {
      detachAbort();
      reject(error);
      return;
    }

    const onRequestError = (error: Error) => {
      detachAbort();
      if (!responseStarted) reject(error);
    };
    request.once("error", onRequestError);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (body?.byteLength) request.write(body);
      request.end();
    } catch (error) {
      detachAbort();
      request.destroy(error instanceof Error ? error : new Error(String(error)));
      if (!responseStarted) reject(error);
    }
  });
}

function requestHeaders(headersInit: HeadersInit | undefined) {
  const headers = new Headers(headersInit);
  headers.delete("host");
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
  const headersObject: Record<string, string> = {};
  headers.forEach((value, key) => {
    headersObject[key] = value;
  });
  return headersObject;
}

function responseHeaders(incoming: IncomingMessage) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.append(key, value);
    }
  }
  return headers;
}

function pinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const matching = addresses.filter(({ family }) => !options.family || options.family === family);
    if (!matching.length) {
      callback(
        Object.assign(new Error("No validated address matches the requested family."), {
          code: "ENOTFOUND",
        }),
        "",
        0,
      );
      return;
    }
    if (options.all) {
      callback(null, matching);
      return;
    }
    const first = matching[0]!;
    callback(null, first.address, first.family);
  };
}

function stripBrackets(value: string) {
  return value.replace(/^\[|\]$/g, "");
}

function abortError(signal: AbortSignal | null | undefined) {
  return signal?.reason instanceof Error ? signal.reason : new Error("The request was aborted.");
}
