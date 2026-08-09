export type ReanalysisBand =
  | "breaking"
  | "developing"
  | "recent"
  | "established"
  | "unknown";

export interface ReanalysisPolicyInput {
  inputType: "text" | "link" | "image";
  publishedAt?: string;
  evidenceQuality?: number;
  overallScore?: number;
  now?: Date;
}

export interface ReanalysisPolicy {
  band: ReanalysisBand;
  dedupHours: number;
  nextReviewHours: number;
  reason: string;
}

/**
 * Product policy for exact-result reuse and evidence decay. Publication
 * freshness is the primary signal. Weak evidence and an inconclusive overall
 * score shorten the next review without changing the exact-submission window.
 */
export function reanalysisPolicy(
  input: ReanalysisPolicyInput,
): ReanalysisPolicy {
  const band = freshnessBand(input.publishedAt, input.now ?? new Date());
  const base = policyForBand(band, input.inputType);
  const thinEvidence =
    typeof input.evidenceQuality === "number" && input.evidenceQuality < 0.45;
  const uncertainScore =
    typeof input.overallScore === "number" &&
    input.overallScore >= 35 &&
    input.overallScore <= 65;
  const nextReviewHours = Math.max(
    3,
    Math.round(
      base.nextReviewHours *
        (thinEvidence ? 0.5 : 1) *
        (uncertainScore ? 0.5 : 1),
    ),
  );
  const accelerators = [
    thinEvidence ? "thin evidence" : null,
    uncertainScore ? "an inconclusive score" : null,
  ].filter((value): value is string => Boolean(value));

  return {
    band,
    dedupHours: base.dedupHours,
    nextReviewHours,
    reason: `${base.reason}${
      accelerators.length
        ? ` Next review accelerated by ${accelerators.join(" and ")}.`
        : ""
    }`,
  };
}

function freshnessBand(
  publishedAt: string | undefined,
  now: Date,
): ReanalysisBand {
  if (!publishedAt) return "unknown";
  const timestamp = Date.parse(publishedAt);
  if (!Number.isFinite(timestamp)) return "unknown";
  const ageHours = Math.max(0, (now.getTime() - timestamp) / 3_600_000);
  if (ageHours <= 48) return "breaking";
  if (ageHours <= 24 * 7) return "developing";
  if (ageHours <= 24 * 30) return "recent";
  return "established";
}

function policyForBand(
  band: ReanalysisBand,
  inputType: ReanalysisPolicyInput["inputType"],
) {
  if (band === "breaking") {
    return {
      dedupHours: 2,
      nextReviewHours: 6,
      reason: "Breaking stories are reused briefly and checked again quickly.",
    };
  }
  if (band === "developing") {
    return {
      dedupHours: 6,
      nextReviewHours: 12,
      reason: "Developing stories are revisited twice per day.",
    };
  }
  if (band === "recent") {
    return {
      dedupHours: 12,
      nextReviewHours: 24,
      reason: "Recent stories are revisited daily.",
    };
  }
  if (band === "established") {
    return {
      dedupHours: 24,
      nextReviewHours: 72,
      reason: "Established stories back off to a three-day review cadence.",
    };
  }
  return inputType === "image"
    ? {
        dedupHours: 6,
        nextReviewHours: 12,
        reason:
          "Images without a publication date use a cautious review cadence.",
      }
    : {
        dedupHours: 12,
        nextReviewHours: 24,
        reason: "Undated submissions use the standard daily review cadence.",
      };
}
