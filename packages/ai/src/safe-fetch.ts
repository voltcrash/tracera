import { resolve4, resolve6 } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

const nativeFetch = globalThis.fetch;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "local",
  "internal",
  "metadata",
  "metadata.google.internal",
  "instance-data.ec2.internal",
  "home.arpa",
]);

const BLOCKED_IPV4_RANGES: readonly (readonly [number, number])[] = [
  [0x00000000, 0x00ffffff],
  [0x0a000000, 0x0affffff],
  [0x64400000, 0x647fffff],
  [0x7f000000, 0x7fffffff],
  [0xa83f8110, 0xa83f8110],
  [0xa9fe0000, 0xa9feffff],
  [0xac100000, 0xac1fffff],
  [0xc0000000, 0xc00000ff],
  [0xc0000200, 0xc00002ff],
  [0xc0586300, 0xc05863ff],
  [0xc0a80000, 0xc0a8ffff],
  [0xc6120000, 0xc613ffff],
  [0xc6336400, 0xc63364ff],
  [0xcb007100, 0xcb0071ff],
  [0xe0000000, 0xffffffff],
];

const BLOCKED_IPV6_RANGES = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fec0::", 10],
  ["fe80::", 10],
  ["ff00::", 8],
] as const;

type ParsedAddress =
  | { version: 4; value: number; octets: [number, number, number, number] }
  | { version: 6; value: bigint; groups: number[] };

type ResolvedAddress = { address: string; family: 4 | 6 };

export type HostAddressResolver = (hostname: string) => Promise<readonly string[]>;

export interface SafeFetchOptions {
  maxRedirects?: number;
  resolveHostAddresses?: HostAddressResolver;
  /** Used by deterministic tests without changing the production transport. */
  fetchImplementation?: typeof fetch;
}

export function createSafeFetch(options: SafeFetchOptions = {}) {
  return (input: string | URL | Request, init?: RequestInit) => safeFetch(input, init, options);
}

export async function safeFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  const request = await normalizeRequest(input, init);
  request.init.signal?.throwIfAborted();
  const redirectMode = request.init.redirect ?? "follow";
  const maxRedirects = validMaxRedirects(options.maxRedirects);
  const fetchImplementation = options.fetchImplementation ?? getFetchOverride();
  const skipHostnameResolution = Boolean(fetchImplementation && !options.resolveHostAddresses);
  let currentUrl = request.url;
  let currentInit = request.init;
  let currentBody = request.body;
  let redirected = false;
  let target = await resolvePublicTarget(
    currentUrl,
    options.resolveHostAddresses,
    skipHostnameResolution,
  );

  for (let redirectCount = 0; ; redirectCount += 1) {
    currentInit.signal?.throwIfAborted();
    const response = await fetchOnce(
      currentUrl,
      currentInit,
      currentBody,
      target,
      redirected,
      fetchImplementation,
    );
    if (!REDIRECT_STATUSES.has(response.status)) {
      return withResponseUrl(response, currentUrl, redirected);
    }

    const location = response.headers.get("location");
    if (!location) {
      await cancelResponse(response);
      throw new Error("The link redirected without a destination.");
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      await cancelResponse(response);
      throw new Error("The link redirected to an invalid destination.");
    }
    const nextTarget = await resolvePublicTarget(
      nextUrl,
      options.resolveHostAddresses,
      skipHostnameResolution,
    );

    if (redirectMode === "error") {
      await cancelResponse(response);
      throw new Error("The link redirected unexpectedly.");
    }
    if (redirectMode === "manual") {
      return withResponseUrl(response, currentUrl, redirected);
    }
    if (redirectCount >= maxRedirects) {
      await cancelResponse(response);
      throw new Error("The link redirected too many times.");
    }

    await cancelResponse(response);
    currentInit = redirectRequestInit(
      currentInit,
      currentBody,
      currentUrl,
      nextUrl,
      response.status,
    );
    currentBody = await serializeBody(currentInit.body);
    currentUrl = nextUrl;
    target = nextTarget;
    redirected = true;
  }
}

export async function assertPublicHttpUrl(
  input: string | URL,
  options: Pick<SafeFetchOptions, "resolveHostAddresses"> = {},
) {
  const url = input instanceof URL ? input : new URL(input);
  await resolvePublicTarget(url, options.resolveHostAddresses);
}

export function isBlockedAddress(address: string) {
  const parsed = parseIp(address);
  if (!parsed) return true;
  if (parsed.version === 4) return isBlockedIpv4(parsed.value);

  const embeddedIpv4 = embeddedIpv4Value(parsed.value);
  if (embeddedIpv4 !== undefined && isBlockedIpv4(embeddedIpv4)) return true;
  if (parsed.value >> 32n === 0n && parsed.value !== 0n) return true;
  return BLOCKED_IPV6_RANGES.some(([base, prefix]) => {
    const parsedBase = parseIp(base);
    return parsedBase?.version === 6 && isInCidr(parsed.value, parsedBase.value, prefix);
  });
}

async function normalizeRequest(input: string | URL | Request, init: RequestInit) {
  if (isRequest(input)) {
    const body = init.body ?? (input.body ? await input.clone().arrayBuffer() : undefined);
    return {
      url: new URL(input.url),
      init: {
        ...init,
        body,
        method: init.method ?? input.method,
        headers: init.headers ?? input.headers,
        redirect: init.redirect ?? input.redirect,
        signal: init.signal ?? input.signal,
      },
      body: await serializeBody(body),
    };
  }
  return {
    url: input instanceof URL ? new URL(input.href) : new URL(input),
    init,
    body: await serializeBody(init.body),
  };
}

function isRequest(input: string | URL | Request): input is Request {
  return typeof Request !== "undefined" && input instanceof Request;
}

async function fetchOnce(
  url: URL,
  init: RequestInit,
  body: Buffer | undefined,
  target: { addresses: ResolvedAddress[] },
  redirected: boolean,
  fetchImplementation: typeof fetch | undefined,
) {
  if (fetchImplementation) {
    const response = await fetchImplementation(url, {
      ...init,
      body: body as unknown as BodyInit | undefined,
      redirect: "manual",
    });
    return withResponseUrl(response, url, redirected);
  }
  return requestPinned(url, init, body, target.addresses, redirected);
}

function getFetchOverride() {
  return globalThis.fetch !== nativeFetch ? globalThis.fetch : undefined;
}

function requestPinned(
  url: URL,
  init: RequestInit,
  body: Buffer | undefined,
  addresses: ResolvedAddress[],
  redirected: boolean,
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
        withResponseUrl(
          new Response(bodyStream, {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage ?? "",
            headers: responseHeaders(incoming),
          }),
          url,
          redirected,
        ),
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

function withResponseUrl(response: Response, url: URL, redirected: boolean) {
  Object.defineProperty(response, "url", { configurable: true, value: url.href });
  Object.defineProperty(response, "redirected", { configurable: true, value: redirected });
  return response;
}

async function cancelResponse(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response may already have been closed by the transport.
  }
}

function redirectRequestInit(
  init: RequestInit,
  body: Buffer | undefined,
  currentUrl: URL,
  nextUrl: URL,
  status: number,
) {
  const method = String(init.method ?? "GET").toUpperCase();
  const discardBody =
    (status === 303 && method !== "GET" && method !== "HEAD") ||
    ((status === 301 || status === 302) && method === "POST");
  const headers = new Headers(init.headers);
  if (discardBody) {
    headers.delete("content-length");
    headers.delete("content-type");
  }
  if (currentUrl.origin !== nextUrl.origin) {
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("proxy-authorization");
  }
  return {
    ...init,
    method: discardBody ? "GET" : init.method,
    headers,
    body: (discardBody ? undefined : body) as unknown as BodyInit | undefined,
  };
}

async function serializeBody(body: BodyInit | Buffer | null | undefined) {
  if (body === null || body === undefined) return undefined;
  return Buffer.from(await new Response(body as BodyInit).arrayBuffer());
}

async function resolvePublicTarget(
  url: URL,
  resolver: HostAddressResolver | undefined,
  skipHostnameResolution = false,
): Promise<{ addresses: ResolvedAddress[] }> {
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP(S) links are supported.");
  if (url.username || url.password) {
    throw new Error("Links with embedded credentials are not supported.");
  }

  const hostname = stripBrackets(url.hostname).toLowerCase().replace(/\.$/, "");
  if (!hostname || isBlockedHostname(hostname)) {
    throw new Error("Links to private network hosts are not supported.");
  }

  const literal = parseIp(hostname);
  const rawAddresses = literal
    ? [formatAddress(literal)]
    : skipHostnameResolution
      ? ["8.8.8.8"]
      : await (resolver ?? resolveHostAddresses)(hostname);
  const addresses = uniqueAddresses(rawAddresses);
  if (
    !addresses ||
    !addresses.length ||
    addresses.some(({ address }) => isBlockedAddress(address))
  ) {
    throw new Error("Links to private network hosts are not supported.");
  }
  return { addresses };
}

function isBlockedHostname(hostname: string) {
  return (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  );
}

async function resolveHostAddresses(hostname: string) {
  const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  const addresses = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (!addresses.length) throw new Error("Could not resolve the link host.");
  return addresses;
}

function uniqueAddresses(rawAddresses: readonly string[]) {
  const seen = new Set<string>();
  const addresses: ResolvedAddress[] = [];
  for (const rawAddress of rawAddresses) {
    if (typeof rawAddress !== "string") return undefined;
    const parsed = parseIp(rawAddress);
    if (!parsed) return undefined;
    const address = formatAddress(parsed);
    if (seen.has(address)) continue;
    seen.add(address);
    addresses.push({ address, family: parsed.version });
  }
  return addresses;
}

function parseIp(address: string): ParsedAddress | undefined {
  const normalized = stripBrackets(address.trim());
  if (normalized.includes(":")) return parseIpv6(normalized);
  if (isIP(normalized) === 4 || /^[0-9a-fx.]+$/i.test(normalized)) {
    return parseIpv4(normalized);
  }
  return undefined;
}

function parseIpv4(address: string): Extract<ParsedAddress, { version: 4 }> | undefined {
  const parts = address.split(".");
  if (parts.length < 1 || parts.length > 4 || parts.some((part) => !part)) return undefined;
  const values = parts.map(parseIpv4Part);
  if (values.some((value) => value === undefined)) return undefined;
  const numbers = values as number[];
  const maximums =
    parts.length === 1
      ? [0xffffffff]
      : parts.length === 2
        ? [0xff, 0xffffff]
        : parts.length === 3
          ? [0xff, 0xff, 0xffff]
          : [0xff, 0xff, 0xff, 0xff];
  if (numbers.some((value, index) => value > maximums[index]!)) return undefined;
  const value =
    parts.length === 1
      ? numbers[0]!
      : parts.length === 2
        ? numbers[0]! * 0x1000000 + numbers[1]!
        : parts.length === 3
          ? numbers[0]! * 0x1000000 + numbers[1]! * 0x10000 + numbers[2]!
          : numbers[0]! * 0x1000000 + numbers[1]! * 0x10000 + numbers[2]! * 0x100 + numbers[3]!;
  if (value > 0xffffffff) return undefined;
  return {
    version: 4,
    value,
    octets: [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff],
  };
}

function parseIpv4Part(part: string) {
  let radix = 10;
  if (/^0x[0-9a-f]+$/i.test(part)) {
    radix = 16;
  } else if (part.length > 1 && part.startsWith("0")) {
    if (!/^0[0-7]+$/.test(part)) return undefined;
    radix = 8;
  } else if (!/^\d+$/.test(part)) {
    return undefined;
  }
  const value = Number.parseInt(part, radix);
  return Number.isSafeInteger(value) ? value : undefined;
}

function parseIpv6(address: string): Extract<ParsedAddress, { version: 6 }> | undefined {
  if (address.includes("%")) return undefined;
  const compression = address.indexOf("::");
  if (compression !== address.lastIndexOf("::")) return undefined;

  const leftText = compression >= 0 ? address.slice(0, compression) : address;
  const rightText = compression >= 0 ? address.slice(compression + 2) : "";
  const left = parseIpv6Side(leftText);
  const right = compression >= 0 ? parseIpv6Side(rightText) : [];
  if (!left || !right) return undefined;

  const groupCount = left.length + right.length;
  if (compression >= 0 && groupCount >= 8) return undefined;
  if (compression < 0 && groupCount !== 8) return undefined;
  const groups =
    compression >= 0
      ? [...left, ...Array.from({ length: 8 - groupCount }, () => 0), ...right]
      : left;
  return { version: 6, value: ipv6Value(groups), groups };
}

function parseIpv6Side(side: string) {
  if (!side) return [];
  const groups: number[] = [];
  const parts = side.split(":");
  for (const [index, part] of parts.entries()) {
    if (part.includes(".")) {
      if (index !== parts.length - 1) return undefined;
      const ipv4 = parseIpv4(part);
      if (!ipv4) return undefined;
      groups.push(ipv4.value >>> 16, ipv4.value & 0xffff);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function ipv6Value(groups: number[]) {
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function formatAddress(parsed: ParsedAddress) {
  if (parsed.version === 4) return parsed.octets.join(".");
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < parsed.groups.length;) {
    if (parsed.groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < parsed.groups.length && parsed.groups[end] === 0) end += 1;
    if (end - index > bestLength && end - index > 1) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart < 0) return parsed.groups.map((group) => group.toString(16)).join(":");
  const before = parsed.groups.slice(0, bestStart).map((group) => group.toString(16));
  const after = parsed.groups.slice(bestStart + bestLength).map((group) => group.toString(16));
  const left = before.join(":");
  const right = after.join(":");
  if (left && right) return `${left}::${right}`;
  if (left) return `${left}::`;
  if (right) return `::${right}`;
  return "::";
}

function embeddedIpv4Value(value: bigint) {
  const prefix = value >> 32n;
  if (prefix !== 0xffffn) return undefined;
  return Number(value & 0xffffffffn);
}

function isBlockedIpv4(value: number) {
  return BLOCKED_IPV4_RANGES.some(([start, end]) => value >= start && value <= end);
}

function isInCidr(value: bigint, base: bigint, prefix: number) {
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return (value & mask) === (base & mask);
}

function stripBrackets(value: string) {
  return value.replace(/^\[|\]$/g, "");
}

function validMaxRedirects(value: number | undefined) {
  if (value === undefined) return DEFAULT_MAX_REDIRECTS;
  if (!Number.isInteger(value) || value < 0) throw new Error("Invalid redirect limit.");
  return value;
}

function abortError(signal: AbortSignal | null | undefined) {
  return signal?.reason instanceof Error ? signal.reason : new Error("The request was aborted.");
}
