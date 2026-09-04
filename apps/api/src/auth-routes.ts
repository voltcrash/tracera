import { createAuth, TRACERA_EXTENSION_ORIGIN, type AuthRuntimeEnv } from "@repo/auth";
import { configureDatabase } from "@repo/db";
import { Hono } from "hono";

export type AuthRoutesBindings = AuthRuntimeEnv & { DATABASE_URL?: string };

const ALLOWED_BROWSER_ORIGINS = new Set([TRACERA_EXTENSION_ORIGIN, "https://dash.better-auth.com"]);

export const authRoutes = new Hono<{ Bindings: AuthRoutesBindings }>();

authRoutes.all("/*", async (context) => {
  if (context.req.method === "OPTIONS") {
    return withExtensionCors(new Response(null, { status: 204 }), context.req.raw);
  }
  configureDatabase(context.env.DATABASE_URL ?? process.env.DATABASE_URL);
  // Better Auth resolves its own routes from the full request URL, which Hono
  // leaves untouched on `raw` even when this app is mounted under a prefix.
  const response = await createAuth(context.env).handler(context.req.raw);
  return withExtensionCors(response, context.req.raw);
});

function withExtensionCors(response: Response, request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || !ALLOWED_BROWSER_ORIGINS.has(origin)) return response;

  response.headers.set("access-control-allow-origin", origin);
  response.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  response.headers.set("access-control-allow-headers", "Content-Type, Authorization");
  response.headers.set("access-control-expose-headers", "Set-Auth-Token");
  response.headers.set("vary", "Origin");
  return response;
}
