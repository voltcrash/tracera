const localWebOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

export function allowedCorsOrigin(origin: string | undefined, requestUrl: string) {
  if (!origin) return undefined;
  const requestOrigin = new URL(requestUrl).origin;
  const normalizedOrigin = origin.replace(/\/$/, "");
  return normalizedOrigin === requestOrigin || localWebOrigin.test(origin) ? origin : undefined;
}
