import { getSessionCookie } from "better-auth/cookies";
import { webRuntimeEnv } from "../../../lib/server-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE_PREFIX = "/api/tracera";

async function proxy(request: Request) {
  const requestUrl = new URL(request.url);
  const upstreamBase = (
    webRuntimeEnv().TRACERA_API_URL ?? "https://api.tracera.voltcrash.com"
  ).replace(/\/$/, "");
  const upstreamUrl = `${upstreamBase}${requestUrl.pathname.slice(ROUTE_PREFIX.length) || "/"}${requestUrl.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");

  // The auth endpoints and browser session live on the web origin, while this
  // route forwards requests to the API origin. Promote the signed Better Auth
  // cookie to the bearer format supported by the API so authentication does
  // not depend on cross-origin cookie forwarding by the deployment runtime.
  if (!headers.has("authorization")) {
    const sessionToken = getSessionCookie(request.headers, {
      cookiePrefix: "tracera",
    });
    if (sessionToken) headers.set("authorization", `Bearer ${sessionToken}`);
  }

  if (request.method === "OPTIONS") {
    return withBrowserCors(new Response(null, { status: 204 }), request);
  }

  const response = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    // Node's fetch requires duplex mode for a streamed request body. The
    // Cloudflare runtime accepts the same standard streaming request.
    duplex: "half",
    redirect: "manual",
    signal: request.signal,
  } as RequestInit & { duplex: "half" });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("access-control-allow-origin");
  responseHeaders.delete("access-control-allow-credentials");
  responseHeaders.set("cache-control", "no-store");
  return withBrowserCors(
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    }),
    request,
  );
}

function withBrowserCors(response: Response, request: Request) {
  const origin = request.headers.get("origin");
  if (origin?.startsWith("chrome-extension://")) {
    response.headers.set("access-control-allow-origin", origin);
    response.headers.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    response.headers.set("access-control-allow-headers", "Content-Type, Authorization");
    response.headers.set("vary", "Origin");
  }
  return response;
}

export {
  proxy as DELETE,
  proxy as GET,
  proxy as HEAD,
  proxy as OPTIONS,
  proxy as PATCH,
  proxy as POST,
  proxy as PUT,
};
