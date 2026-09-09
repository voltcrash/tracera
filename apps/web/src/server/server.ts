import { TRACERA_AUTH_BASE_PATH } from "@repo/auth";
import { getSessionCookie } from "better-auth/cookies";
import { Hono } from "hono";
import { TRACERA_API_BASE_PATH } from "./base-path";
import { authRoutes } from "./auth-routes";
import {
  applySecurityHeaders,
  contentSecurityPolicy,
  PRIVATE_NO_STORE_CACHE,
} from "../security-headers";
import { app as traceraApi, type Bindings } from "./index";

/**
 * Single Hono app behind the Next.js `/api/*` catch-all route. Better Auth
 * keeps its `/api/auth` base path and the application API uses `/api/tracera`.
 */
export const server = new Hono<{ Bindings: Bindings }>();

server.use("*", async (context, next) => {
  const authenticatedRequest = Boolean(
    getSessionCookie(context.req.raw, { cookiePrefix: "tracera" }) ||
    context.req.header("authorization"),
  );

  await next();

  const response = context.res;
  applySecurityHeaders(
    response,
    contentSecurityPolicy({ isDevelopment: process.env.NODE_ENV === "development" }),
  );
  if (authenticatedRequest || response.headers.has("set-cookie")) {
    response.headers.set("Cache-Control", PRIVATE_NO_STORE_CACHE);
  }
});

server.route(TRACERA_AUTH_BASE_PATH, authRoutes);
server.route(TRACERA_API_BASE_PATH, traceraApi);
