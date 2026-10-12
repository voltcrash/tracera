import { getSessionCookie } from "better-auth/cookies";
import {
  GENERIC_ERROR_MESSAGE,
  logServerError,
  REQUEST_ID_HEADER,
  requestIdFor,
} from "./error-handling";
import { NONCE_HEADER } from "./nonce";
import {
  applySecurityHeaders,
  contentSecurityPolicy,
  PRIVATE_NO_STORE_CACHE,
} from "../security-headers";

/**
 * Every Worker response gets the request ID, security headers and the CSP for this
 * request's nonce. Signed-in requests and cookie-setting responses are never cached.
 */
export function securedResponse(response: Response, request: Request, development: boolean) {
  const secured = new Response(response.body, response);
  const nonce = request.headers.get(NONCE_HEADER) ?? undefined;
  applySecurityHeaders(secured, contentSecurityPolicy({ nonce, isDevelopment: development }));
  secured.headers.set(REQUEST_ID_HEADER, requestIdFor(request));
  const authenticated = Boolean(
    getSessionCookie(request, { cookiePrefix: "tracera" }) || request.headers.get("authorization"),
  );
  if (authenticated || secured.headers.has("set-cookie"))
    secured.headers.set("cache-control", PRIVATE_NO_STORE_CACHE);
  return secured;
}

/** The JSON error envelope for failures that escape a handler. */
export function errorEnvelope(request: Request, error: unknown) {
  const requestId = requestIdFor(request);
  logServerError("Unhandled Worker request error", error, request);
  return Response.json({ error: GENERIC_ERROR_MESSAGE, requestId }, { status: 500 });
}
