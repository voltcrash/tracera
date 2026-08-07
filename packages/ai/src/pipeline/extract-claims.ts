import { z } from "zod";
import type { AiProvider } from "../provider.js";
import type { ExtractedClaim } from "./types.js";

const extractedClaimSchema = z.object({
  id: z.string().min(1),
  claimText: z.string().min(1),
  claimType: z.enum(["factual_assertion", "opinion", "framing"]),
  checkability: z.enum(["checkable", "needs_context", "not_checkable"]),
  context: z.string(),
});

// A claim map is a concise summary, not a line-by-line paraphrase of an article.
const extractionSchema = z.object({
  claims: z.array(extractedClaimSchema).max(3),
});

const CLAIM_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "amid",
  "and",
  "are",
  "been",
  "before",
  "being",
  "but",
  "could",
  "from",
  "have",
  "into",
  "its",
  "more",
  "not",
  "over",
  "said",
  "that",
  "the",
  "their",
  "there",
  "these",
  "this",
  "those",
  "through",
  "under",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
]);

export async function extractClaims(
  provider: AiProvider,
  text: string,
): Promise<ExtractedClaim[]> {
  const result = await provider.generate(
    `Decompose the following news text into at most 3 high-salience, atomic factual claims for fact checking.\n\n${text}\n\n` +
      "Return only factual assertions explicitly stated in the supplied text that could be corroborated or contradicted by evidence. " +
      "Do not infer, combine, complete, or speculate beyond the text. Do not turn vague context, rhetoric, headlines, opinions, predictions, or framing into claims. " +
      "Every person, place, organisation, number, date, event, and qualifier in claimText must appear in the supplied text. " +
      "Prefer the three most central claims; returning fewer is correct when fewer are clearly stated. Use factual_assertion as the claim type.",
    extractionSchema,
  );

  return result.claims
    .filter((claim) => claim.claimType === "factual_assertion")
    .filter((claim) => claim.checkability !== "not_checkable")
    .filter((claim) => isGroundedInInput(claim.claimText, text))
    .slice(0, 3);
}

/** Reject model-introduced details before they reach retrieval. */
function isGroundedInInput(claimText: string, input: string) {
  const claimTerms = meaningfulTerms(claimText);
  const inputTerms = new Set(meaningfulTerms(input));
  if (claimTerms.length === 0) return false;

  const coverage =
    claimTerms.filter((term) => inputTerms.has(term)).length /
    claimTerms.length;
  const claimNumbers = claimText.match(/\b\d+(?:[.,]\d+)?\b/g) ?? [];
  return (
    coverage >= 0.6 && claimNumbers.every((value) => input.includes(value))
  );
}

function meaningfulTerms(text: string) {
  return text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !CLAIM_STOP_WORDS.has(word));
}
