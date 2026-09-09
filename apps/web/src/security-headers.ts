export const PRIVATE_NO_STORE_CACHE = "private, no-store";

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  "X-Frame-Options": "DENY",
} as const;

export function contentSecurityPolicy({
  nonce,
  isDevelopment = false,
}: { nonce?: string; isDevelopment?: boolean } = {}) {
  const scriptSources = ["'self'", ...(nonce ? [`'nonce-${nonce}'`, "'strict-dynamic'"] : [])];
  if (isDevelopment) scriptSources.push("'unsafe-eval'");

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `style-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}`,
    "style-src-attr 'unsafe-inline'",
    "script-src-attr 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "manifest-src 'self'",
    "worker-src 'self'",
    ...(isDevelopment ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function applySecurityHeaders(response: Response, policy = contentSecurityPolicy()) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  response.headers.set("Content-Security-Policy", policy);
  return response;
}
