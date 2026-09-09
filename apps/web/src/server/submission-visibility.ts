import { AnalysisError } from "./analysis-errors";

export function requestedVisibility(body: unknown, userId: string | undefined) {
  const requested =
    body && typeof body === "object" && (body as { visibility?: unknown }).visibility === "public"
      ? "public"
      : "private";
  const consented =
    body &&
    typeof body === "object" &&
    (body as { publishConsent?: unknown }).publishConsent === true;

  if (requested === "public" && !consented) {
    throw new AnalysisError("publication_consent_required");
  }
  if (!userId) {
    throw new Error("Sign in before saving a private trace.");
  }
  return requested;
}
