import { z } from "zod";
import type { AiProvider } from "../provider";
import type { ClaimVerdict, EvidenceSource, ExtractedClaim } from "./types";
import type { PromptAuditOptions } from "./extract-claims";

const verdictSchema = z.object({
  verdict: z.enum(["supported", "contradicted", "misleading", "mixed", "unverified"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.array(z.string().min(1)).min(1).max(4),
  supportingSourceIds: z.array(z.string()),
  contradictingSourceIds: z.array(z.string()),
});

export async function scoreClaim(
  provider: AiProvider,
  claim: ExtractedClaim,
  sources: EvidenceSource[],
  audit?: PromptAuditOptions,
): Promise<ClaimVerdict> {
  // A retrieval outage or a story that is too new to be indexed must never
  // turn into an analysis failure. Surface the absence of corroboration as a
  // useful, explicitly unverified result instead of asking the model to invent
  // a verdict from an empty evidence set.
  if (sources.length === 0) {
    return {
      claim,
      verdict: "unverified",
      confidence: 0.2,
      reasoning: [
        "No relevant external evidence was retrieved at the time of this check.",
        "This claim is unverified, not disproven; re-check as reporting develops.",
      ],
      consideredSources: [],
      supportingSources: [],
      contradictingSources: [],
      sourceConflict: false,
      evidenceQuality: 0,
    };
  }

  const evidence = sources.map((source) => ({
    id: source.id,
    type: source.type,
    title: source.title,
    publisher: source.publisher,
    claimText: source.claimText,
    verdict: source.verdict,
    rating: source.rating,
    snippet: source.snippet,
    publishedAt: source.publishedAt,
    similarity: source.similarity,
    credibility: source.credibility,
  }));
  const prompt = buildVerdictPrompt(claim, evidence);
  audit?.onPrompt?.({ stage: "verdict_generation", prompt });
  const generated = await provider.generate(prompt, verdictSchema, {
    signal: audit?.signal,
    onStructuredOutputAttempt: (attempt) =>
      audit?.onStructuredOutputAttempt?.({
        stage: "verdict_generation",
        ...attempt,
      }),
  });
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const supportingSources = generated.supportingSourceIds
    .map((id) => sourceById.get(id))
    .filter((source): source is EvidenceSource => Boolean(source));
  const contradictingSources = generated.contradictingSourceIds
    .map((id) => sourceById.get(id))
    .filter((source): source is EvidenceSource => Boolean(source));

  return {
    claim,
    verdict: generated.verdict,
    confidence: generated.confidence,
    reasoning: generated.reasoning,
    consideredSources: sources,
    supportingSources,
    contradictingSources,
    sourceConflict: supportingSources.length > 0 && contradictingSources.length > 0,
    evidenceQuality: estimateEvidenceQuality(sources),
  };
}

export function buildVerdictPrompt(claim: ExtractedClaim, evidence: unknown) {
  return (
    `Evaluate this claim: ${claim.claimText}\n\n` +
    `Its type is ${claim.claimType} and its checkability is ${claim.checkability}.\n\n` +
    `Retrieved evidence:\n${JSON.stringify(evidence)}\n\n` +
    "Use only the evidence listed above. Return unverified when evidence is missing or inadequate. " +
    "A submitted_source records what the analyzed item says; it is not independent corroboration and cannot support a claim by itself. " +
    "Provide 1–4 concise evidence-based justification steps, each tied to a source ID where possible. " +
    "If credible sources conflict, return mixed or misleading as appropriate and include IDs on both sides; never average conflicts away. " +
    "Only use source IDs included in the retrieved evidence."
  );
}

function estimateEvidenceQuality(sources: EvidenceSource[]) {
  if (sources.length === 0) {
    return 0;
  }

  const corroboration = Math.min(sources.length / 3, 1);
  const newest = sources
    .map((source) => source.publishedAt)
    .filter((date): date is string => Boolean(date))
    .map((date) => Date.parse(date))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  const ageDays = newest ? (Date.now() - newest) / 86_400_000 : Number.POSITIVE_INFINITY;
  const recency = ageDays <= 30 ? 1 : ageDays <= 365 ? 0.7 : ageDays <= 1825 ? 0.4 : 0.2;

  const credibility =
    sources.reduce((sum, source) => sum + (source.credibility ?? 0.5), 0) / sources.length;
  const relevance =
    sources.reduce((sum, source) => sum + (source.similarity ?? 0.7), 0) / sources.length;
  return Number(
    (0.25 * corroboration + 0.2 * recency + 0.2 * credibility + 0.35 * relevance).toFixed(4),
  );
}
