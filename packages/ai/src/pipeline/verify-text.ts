import { aggregateScore } from "./aggregate-score.js";
import { analyzeFraming } from "./analyze-framing.js";
import { extractClaims } from "./extract-claims.js";
import { retrieveSources } from "./retrieve-sources.js";
import { scoreClaim } from "./score-claim.js";
import type { ClaimVerdict, TraceraScore, VerifyTextOptions } from "./types.js";

export async function verifyText(
  text: string,
  options: VerifyTextOptions,
): Promise<{
  claims: ClaimVerdict[];
  score: TraceraScore;
  framing: import("./types.js").FramingAnalysis;
}> {
  const [extractedClaims, framing] = await Promise.all([
    extractClaims(options.provider, text, { signal: options.signal }),
    analyzeFraming(options.provider, text, { signal: options.signal }),
  ]);
  const claimVerdicts: ClaimVerdict[] = [];

  for (const claim of extractedClaims) {
    const sources = await retrieveSources(claim, {
      ...options,
      storyContext: options.storyContext ?? text,
    });
    claimVerdicts.push(
      await scoreClaim(options.provider, claim, sources, { signal: options.signal }),
    );
  }

  return {
    claims: claimVerdicts,
    score: aggregateScore(claimVerdicts, framing),
    framing,
  };
}
