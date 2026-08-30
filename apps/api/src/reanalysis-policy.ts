export type ReanalysisBand = "breaking" | "developing" | "recent" | "established" | "unknown";

export interface ReanalysisPolicyInput {
  inputType: "text" | "link" | "image";
  publishedAt?: string;
  now?: Date;
}

export interface ReanalysisPolicy {
  band: ReanalysisBand;
  dedupHours: number;
  reason: string;
}

/**
 * Product policy for exact-result reuse. Publication freshness determines how
 * briefly an identical submission can reuse an existing result.
 */
export function reanalysisPolicy(input: ReanalysisPolicyInput): ReanalysisPolicy {
  const band = freshnessBand(input.publishedAt, input.now ?? new Date());
  return { band, ...policyForBand(band, input.inputType) };
}

function freshnessBand(publishedAt: string | undefined, now: Date): ReanalysisBand {
  if (!publishedAt) return "unknown";
  const timestamp = Date.parse(publishedAt);
  if (!Number.isFinite(timestamp)) return "unknown";
  const ageHours = Math.max(0, (now.getTime() - timestamp) / 3_600_000);
  if (ageHours <= 48) return "breaking";
  if (ageHours <= 24 * 7) return "developing";
  if (ageHours <= 24 * 30) return "recent";
  return "established";
}

function policyForBand(band: ReanalysisBand, inputType: ReanalysisPolicyInput["inputType"]) {
  if (band === "breaking") {
    return {
      dedupHours: 2,
      reason: "Breaking stories reuse identical results for only a short period.",
    };
  }
  if (band === "developing") {
    return {
      dedupHours: 6,
      reason: "Developing stories use a six-hour identical-result window.",
    };
  }
  if (band === "recent") {
    return {
      dedupHours: 12,
      reason: "Recent stories use a twelve-hour identical-result window.",
    };
  }
  if (band === "established") {
    return {
      dedupHours: 24,
      reason: "Established stories use a one-day identical-result window.",
    };
  }
  return inputType === "image"
    ? {
        dedupHours: 6,
        reason: "Undated images use a six-hour identical-result window.",
      }
    : {
        dedupHours: 12,
        reason: "Undated submissions use a twelve-hour identical-result window.",
      };
}
