/** Prefix the Hono API is mounted under inside the Next.js `/api/*` route. */
export const TRACERA_API_BASE_PATH = "/api/tracera";

export function apiRelativePath(path: string) {
  return path.startsWith(TRACERA_API_BASE_PATH)
    ? path.slice(TRACERA_API_BASE_PATH.length) || "/"
    : path;
}
