import type { Context, MiddlewareHandler } from "hono";

export const REQUEST_ID_HEADER = "x-request-id";
export const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again later.";
export const SERVICE_UNAVAILABLE_MESSAGE =
  "This service is temporarily unavailable. Please try again later.";

const MAX_DIAGNOSTIC_TEXT_LENGTH = 2_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE_KEY_PATTERN =
  "(?:password|passwd|pwd|secret|token|api[-_]?key|authorization|cookie|credential|client[-_]?secret|private[-_]?key)";
const requestIds = new WeakMap<Request, string>();

export const requestIdMiddleware: MiddlewareHandler = async (context, next) => {
  const requestId = requestIdFor(context.req.raw);
  context.header(REQUEST_ID_HEADER, requestId);
  await next();
  context.header(REQUEST_ID_HEADER, requestId);
};

export function requestIdFor(request: Request) {
  const cached = requestIds.get(request);
  if (cached) return cached;

  const requested = request.headers.get(REQUEST_ID_HEADER)?.trim();
  const requestId =
    requested && REQUEST_ID_PATTERN.test(requested) ? requested : crypto.randomUUID();
  requestIds.set(request, requestId);
  return requestId;
}

export function requestIdForContext(context: Context) {
  const requestId = requestIdFor(context.req.raw);
  context.header(REQUEST_ID_HEADER, requestId);
  return requestId;
}

export function sanitizedErrorDetails(error: unknown) {
  const details: { name: string; message: string; stack?: string; code?: string } = {
    name: "UnknownError",
    message: sanitizeDiagnosticText(stringValue(error)),
  };

  if (error instanceof Error) {
    details.name = sanitizeDiagnosticText(error.name || "Error");
    details.message = sanitizeDiagnosticText(error.message || "Unknown error");
    if (error.stack) details.stack = sanitizeDiagnosticText(error.stack);
    const code = errorProperty(error, "code");
    if (typeof code === "string" && code) details.code = sanitizeDiagnosticText(code);
  }

  return details;
}

export function sanitizeDiagnosticText(value: string) {
  const sanitized = value
    .replace(/\b([a-z][a-z\d+.-]*:\/\/)([^/\s@]+)@/gi, "$1[REDACTED]@")
    .replace(new RegExp(`([?&]${SENSITIVE_KEY_PATTERN}=)[^&\\s]+`, "gi"), "$1[REDACTED]")
    .replace(
      new RegExp(
        `((?:"|')?${SENSITIVE_KEY_PATTERN}(?:"|')?\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;}]+)`,
        "gi",
      ),
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED KEY]")
    .replace(/\bdata:[^,\s]+,[^\s]+/gi, "data:[REDACTED]");

  return truncate(sanitized);
}

export function logServerError(label: string, error: unknown, request: Request) {
  logServerDiagnostic(console.error, label, error, request);
}

export function logServerWarning(label: string, error: unknown, request: Request) {
  logServerDiagnostic(console.warn, label, error, request);
}

export function internalErrorResponse(context: Context, error: unknown, label: string) {
  const requestId = requestIdForContext(context);
  logServerError(label, error, context.req.raw);
  return context.json({ error: GENERIC_ERROR_MESSAGE, requestId }, 500);
}

export function serviceUnavailableResponse(
  context: Context,
  error: unknown,
  message: string,
  label: string,
) {
  const requestId = requestIdForContext(context);
  logServerError(label, error, context.req.raw);
  return context.json({ error: message, requestId }, 503);
}

export function healthErrorResponse(context: Context, error: unknown) {
  const requestId = requestIdForContext(context);
  logServerError("Health check failed", error, context.req.raw);
  return context.json({ status: "error", message: SERVICE_UNAVAILABLE_MESSAGE, requestId }, 503);
}

function truncate(value: string) {
  return value.length <= MAX_DIAGNOSTIC_TEXT_LENGTH
    ? value
    : `${value.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH - 3)}...`;
}

function stringValue(value: unknown) {
  try {
    return typeof value === "string" ? value : String(value);
  } catch {
    return "Unable to inspect thrown value.";
  }
}

function errorProperty(error: Error, property: string) {
  try {
    return (error as unknown as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

function logServerDiagnostic(
  logger: (...values: unknown[]) => void,
  label: string,
  error: unknown,
  request: Request,
) {
  logger(sanitizeDiagnosticText(label), {
    requestId: requestIdFor(request),
    error: sanitizedErrorDetails(error),
  });
}
