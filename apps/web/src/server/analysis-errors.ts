export const ANALYSIS_ERROR_MESSAGES = {
  no_checkable_claims:
    "No checkable claims could be extracted. Please provide the article text or a public news link.",
  publication_consent_required:
    "Publishing requires your explicit consent to make the submitted text, images, metadata, and analysis results public.",
  analysis_unavailable: "Analysis is temporarily unavailable. Please try again.",
} as const;

export type AnalysisErrorCode = keyof typeof ANALYSIS_ERROR_MESSAGES;

export class AnalysisError extends Error {
  constructor(readonly code: AnalysisErrorCode) {
    super(ANALYSIS_ERROR_MESSAGES[code]);
    this.name = "AnalysisError";
  }
}

export function publicAnalysisError(error: unknown): {
  code: AnalysisErrorCode;
  message: string;
  status: 400 | 422 | 503;
} {
  const code = error instanceof AnalysisError ? error.code : "analysis_unavailable";
  return {
    code,
    message: ANALYSIS_ERROR_MESSAGES[code],
    status:
      code === "publication_consent_required" ? 400 : code === "no_checkable_claims" ? 422 : 503,
  };
}
