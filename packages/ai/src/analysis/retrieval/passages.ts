import type { Claim, DocumentSnapshot } from "@repo/contracts/analysis";
import type { PassageCandidate } from "./types";

export function selectPassageCandidates(
  snapshot: DocumentSnapshot,
  claim: Claim,
  limit: number,
): PassageCandidate[] {
  if (limit === 0) return [];
  const terms = new Set(
    [
      claim.proposition.subject,
      claim.proposition.predicate,
      claim.proposition.object,
      ...claim.proposition.qualifiers,
      claim.attribution.attributedTo,
      ...claim.quantities.flatMap((quantity) => [quantity.rawText, quantity.denominatorText]),
      claim.time.statedText,
      claim.place,
    ]
      .filter((value): value is string => value !== null)
      .flatMap(tokenize),
  );
  const locators = snapshot.locators.length
    ? snapshot.locators
    : [{ span: { start: 0, end: snapshot.normalizedText.length } }];
  return locators
    .map(({ span }) => {
      const text = snapshot.normalizedText.slice(span.start, span.end);
      const tokens = new Set(tokenize(text));
      let overlap = 0;
      for (const term of terms) if (tokens.has(term)) overlap += 1;
      return {
        snapshotId: snapshot.id,
        span,
        text,
        lexicalScore: terms.size === 0 ? 0 : overlap / terms.size,
        requiresAssessment: true as const,
      };
    })
    .filter(({ text }) => text.trim() !== "")
    .sort(
      (left, right) => right.lexicalScore - left.lexicalScore || left.span.start - right.span.start,
    )
    .slice(0, limit);
}

function tokenize(value: string) {
  return (
    value
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length > 1) ?? []
  );
}
