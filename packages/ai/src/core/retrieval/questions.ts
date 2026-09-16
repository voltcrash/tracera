import type { ClaimV2, QueryIntent, SufficiencyFeedback } from "@repo/contracts/core-v2";
import type { RetrievalQuestion } from "./types";

const quote = (value: string) => `"${value.replaceAll('"', "").trim()}"`;

export function buildPropositionKey(claim: ClaimV2): string {
  return JSON.stringify({
    proposition: claim.proposition,
    attribution: claim.attribution,
    negated: claim.negated,
    quantities: claim.quantities,
    time: claim.time,
    place: claim.place,
  });
}

export function buildRetrievalQuestions(
  claim: ClaimV2,
  round: number,
  feedback: SufficiencyFeedback | null,
): RetrievalQuestion[] {
  if (round > 0) return targetedQuestions(claim, feedback);

  const scoped = scopedTerms(claim);
  const exact = quote(claim.text);
  const transformations = [
    { kind: "quoted" as const, sourceText: claim.text, outputText: exact, language: null },
  ];
  const questions: RetrievalQuestion[] = [
    question(claim, "neutral", `What reliable records establish whether ${claim.text}?`, scoped),
    question(
      claim,
      "disconfirming",
      `What reliable evidence conflicts with or corrects the scoped assertion: ${claim.text}?`,
      `${scoped} correction contradiction false`,
    ),
    question(
      claim,
      "primary_source",
      `Which original record or responsible institution can answer: ${claim.text}?`,
      `${scoped} official record report dataset`,
    ),
    question(
      claim,
      "supporting",
      `What reliable evidence supports the complete scoped assertion: ${claim.text}?`,
      `${scoped} evidence`,
    ),
  ];

  if (claim.time.statedText !== null) {
    questions.push({
      ...question(
        claim,
        "date_constrained",
        `What evidence was applicable to ${claim.time.statedText} for: ${claim.text}?`,
        `${scoped} ${quote(claim.time.statedText)}`,
      ),
      dateRange: knownInterval(claim) ? claim.time.interval : null,
    });
  }

  if (claim.attribution.kind !== "direct_assertion") {
    const speaker = claim.attribution.attributedTo;
    questions.unshift({
      ...question(
        claim,
        "neutral",
        `Did the attributed source make this statement: ${claim.text}?`,
        speaker === null ? exact : `${quote(speaker)} ${exact}`,
      ),
      transformations,
    });
  } else {
    questions[0] = { ...questions[0]!, query: `${questions[0]!.query} ${exact}`, transformations };
  }

  return unique(questions);
}

function targetedQuestions(
  claim: ClaimV2,
  feedback: SufficiencyFeedback | null,
): RetrievalQuestion[] {
  if (feedback === null || feedback.sufficient || feedback.claimId !== claim.id) return [];
  const supplied = feedback.suggestedQueries.map(({ query, intent }) => ({
    ...question(claim, intent, `Targeted follow-up for ${intent}: ${claim.text}`, query),
    transformations: [
      {
        kind: "sufficiency_suggestion" as const,
        sourceText: claim.text,
        outputText: query,
        language: null,
      },
    ],
  }));
  const generated = feedback.missing.map((missing) => {
    const intent: QueryIntent =
      missing === "disconfirming_evidence" ? "disconfirming" : "primary_source";
    return question(
      claim,
      intent,
      `Which evidence fills the ${missing.replaceAll("_", " ")} gap for: ${claim.text}?`,
      `${scopedTerms(claim)} ${missing.replaceAll("_", " ")}`,
    );
  });
  return unique([...supplied, ...generated]);
}

function question(
  claim: ClaimV2,
  intent: QueryIntent,
  prompt: string,
  queryText: string,
): RetrievalQuestion {
  return {
    claimId: claim.id,
    question: prompt,
    query: queryText.replace(/\s+/g, " ").trim(),
    intent,
    dateRange: null,
    transformations: [],
  };
}

function scopedTerms(claim: ClaimV2): string {
  if (claim.checkability === "needs_context") return quote(claim.text);
  const values = [
    claim.proposition.subject,
    claim.proposition.predicate,
    claim.proposition.object,
    ...claim.proposition.qualifiers,
    claim.attribution.attributedTo,
    claim.negated ? "not" : null,
    ...claim.quantities.flatMap((quantity) => [
      quantity.rawText,
      quantity.unit,
      quantity.denominatorText,
    ]),
    claim.time.statedText,
    claim.place,
  ];
  return values.filter((value): value is string => value !== null && value.trim() !== "").join(" ");
}

function knownInterval(claim: ClaimV2) {
  return claim.time.interval.earliest !== null && claim.time.interval.latest !== null;
}

function unique(questions: RetrievalQuestion[]) {
  const seen = new Set<string>();
  return questions.filter(({ query, intent }) => {
    const key = `${intent}\0${query.toLocaleLowerCase("en-US")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
