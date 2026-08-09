const localWebOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

export function allowedCorsOrigin(
  origin: string | undefined,
  configuredOrigins: string | undefined,
) {
  if (!origin) return undefined;

  const allowedOrigins = (configuredOrigins ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);

  const normalizedOrigin = origin.replace(/\/$/, "");
  return allowedOrigins.includes(normalizedOrigin) || localWebOrigin.test(origin)
    ? origin
    : undefined;
}
