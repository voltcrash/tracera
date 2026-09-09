import { createAuth, type AuthRuntimeEnv } from "@repo/auth";
import { configureDatabase } from "@repo/db";
import { Hono } from "hono";
import {
  GENERIC_ERROR_MESSAGE,
  REQUEST_ID_HEADER,
  internalErrorResponse,
  logServerError,
  requestIdFor,
  requestIdMiddleware,
} from "./error-handling";

export type AuthRoutesBindings = AuthRuntimeEnv & { DATABASE_URL?: string };

export const authRoutes = new Hono<{ Bindings: AuthRoutesBindings }>();

authRoutes.use("*", requestIdMiddleware);
authRoutes.onError((error, context) =>
  internalErrorResponse(context, error, "Unhandled authentication error"),
);

authRoutes.all("/*", async (context) => {
  configureDatabase(context.env.DATABASE_URL ?? process.env.DATABASE_URL);
  // Better Auth resolves its own routes from the full request URL, which Hono
  // leaves untouched on `raw` even when this app is mounted under a prefix.
  const response = await createAuth(context.env, context.req.url).handler(context.req.raw);
  return publicAuthResponse(response, context.req.raw);
});

function publicAuthResponse(response: Response, request: Request) {
  if (response.status < 500) return response;

  const requestId = requestIdFor(request);
  logServerError(
    "Authentication service returned an error",
    new Error(`Better Auth returned HTTP ${response.status}.`),
    request,
  );
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set(REQUEST_ID_HEADER, requestId);
  return new Response(
    JSON.stringify({
      error: GENERIC_ERROR_MESSAGE,
      message: GENERIC_ERROR_MESSAGE,
      code: "INTERNAL_SERVER_ERROR",
      requestId,
    }),
    { status: response.status, statusText: response.statusText, headers },
  );
}
