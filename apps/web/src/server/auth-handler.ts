import type { ServerEnv } from "./env";
import {
  GENERIC_ERROR_MESSAGE,
  logServerError,
  REQUEST_ID_HEADER,
  requestIdFor,
} from "./error-handling";
import { authFor } from "./session.server";

export async function handleAuthRequest(env: ServerEnv, request: Request) {
  try {
    return publicAuthResponse(await authFor(env, request).handler(request), request);
  } catch (error) {
    logServerError("Unhandled authentication error", error, request);
    return errorResponse(request, 500, new Headers());
  }
}

/** Better Auth's 5xx bodies can carry internals, so they become the generic error body. */
export function publicAuthResponse(response: Response, request: Request) {
  if (response.status < 500) return response;
  logServerError(
    "Authentication service returned an error",
    new Error(`Better Auth returned HTTP ${response.status}.`),
    request,
  );
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return errorResponse(request, response.status, headers, response.statusText);
}

function errorResponse(request: Request, status: number, headers: Headers, statusText?: string) {
  const requestId = requestIdFor(request);
  headers.set("content-type", "application/json");
  headers.set(REQUEST_ID_HEADER, requestId);
  return new Response(
    JSON.stringify({
      error: GENERIC_ERROR_MESSAGE,
      message: GENERIC_ERROR_MESSAGE,
      code: "INTERNAL_SERVER_ERROR",
      requestId,
    }),
    { status, statusText, headers },
  );
}
