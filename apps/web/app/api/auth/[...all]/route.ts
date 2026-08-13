import { createAuth, TRACERA_EXTENSION_ORIGIN } from "@repo/auth";
import { configureDatabase } from "@repo/db";
import { webRuntimeEnv } from "../../../lib/server-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function authHandler(request: Request) {
  if (request.method === "OPTIONS") {
    return withExtensionCors(new Response(null, { status: 204 }), request);
  }
  const env = webRuntimeEnv();
  configureDatabase(env.DATABASE_URL);
  return withExtensionCors(await createAuth(env).handler(request), request);
}

function withExtensionCors(response: Response, request: Request) {
  const origin = request.headers.get("origin");
  if (origin !== TRACERA_EXTENSION_ORIGIN && origin !== "https://dash.better-auth.com") {
    return response;
  }
  response.headers.set("access-control-allow-origin", origin);
  response.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  response.headers.set("access-control-allow-headers", "Content-Type, Authorization");
  response.headers.set("access-control-expose-headers", "Set-Auth-Token");
  response.headers.set("vary", "Origin");
  return response;
}

export { authHandler as GET, authHandler as OPTIONS, authHandler as POST };
