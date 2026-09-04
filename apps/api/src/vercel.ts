import { getRequestListener } from "@hono/node-server";
import { TRACERA_API_BASE_PATH } from "./base-path.js";
import { server } from "./server.js";

const FORWARDED_PATH_PARAM = "__vpath";
const DEFAULT_API_HOST = "api.tracera.voltcrash.com";

export default getRequestListener((request) =>
  server.fetch(routedRequest(request), process.env as Record<string, string | undefined>),
);

function routedRequest(request: Request) {
  const url = new URL(request.url);
  const forwarded = url.searchParams.get(FORWARDED_PATH_PARAM);
  if (forwarded) {
    url.searchParams.delete(FORWARDED_PATH_PARAM);
    // The platform may deliver either the original path or the routed `/api`
    // destination, so the original path travels along as a query parameter.
    if (url.pathname === "/api") url.pathname = forwarded;
  }

  const pathname = serverPath(url.pathname, url.hostname);
  if (pathname === url.pathname && !forwarded) return request;

  url.pathname = pathname;
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(url, init);
}

export function serverPath(rawPathname: string, hostname: string) {
  // Hono matches mounted routes without a trailing slash.
  const pathname =
    rawPathname.length > 1 && rawPathname.endsWith("/") ? rawPathname.slice(0, -1) : rawPathname;

  // The legacy API subdomain exposes the same routes without the shared
  // `/api/tracera` prefix used on the product origin.
  if (hostname === (process.env.TRACERA_API_HOST ?? DEFAULT_API_HOST)) {
    return `${TRACERA_API_BASE_PATH}${pathname === "/" ? "" : pathname}`;
  }
  return pathname === "/api/health" ? `${TRACERA_API_BASE_PATH}/health` : pathname;
}
