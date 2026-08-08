import { aggregateScore } from "./aggregate-score.js";
import { extractClaims } from "./extract-claims.js";
import { retrieveSources } from "./retrieve-sources.js";
import { scoreClaim } from "./score-claim.js";
import type { ClaimVerdict, TraceraScore, VerifyTextOptions } from "./types.js";

export async function verifyText(
  text: string,
  options: VerifyTextOptions,
): Promise<{ claims: ClaimVerdict[]; score: TraceraScore }> {
  const extractedClaims = await extractClaims(options.provider, text);
  const claimVerdicts: ClaimVerdict[] = [];

  for (const claim of extractedClaims) {
    const sources = await retrieveSources(claim, options);
    claimVerdicts.push(await scoreClaim(options.provider, claim, sources));
  }

  return { claims: claimVerdicts, score: aggregateScore(claimVerdicts) };
}
