import { z } from "zod";
import type { AiProvider } from "../provider";
import type { PromptAuditOptions } from "./extract-claims";
import type { FramingAnalysis } from "./types";

const framingSchema = z.object({
  emotionalLanguageLevel: z.number().min(0).max(1),
  factualSkewLevel: z.number().min(0).max(1),
  contextOmissionRisk: z.number().min(0).max(1),
  findings: z.array(z.string().min(1)).max(4),
});

export async function analyzeFraming(
  provider: AiProvider,
  text: string,
  audit?: PromptAuditOptions,
): Promise<FramingAnalysis> {
  const prompt = buildFramingPrompt(text);
  audit?.onPrompt?.({ stage: "framing_analysis", prompt });
  const result = await provider.generate(prompt, framingSchema, {
    signal: audit?.signal,
    onStructuredOutputAttempt: (attempt) =>
      audit?.onStructuredOutputAttempt?.({
        stage: "framing_analysis",
        ...attempt,
      }),
  });
  const integrityScore =
    1 -
    (0.4 * result.emotionalLanguageLevel +
      0.4 * result.factualSkewLevel +
      0.2 * result.contextOmissionRisk);
  return {
    ...result,
    integrityScore: Number(Math.max(0, Math.min(1, integrityScore)).toFixed(4)),
  };
}

export function buildFramingPrompt(text: string) {
  return (
    "Assess presentation and framing in the complete news text below, independently of whether its factual claims are true. " +
    "Score each level from 0 (absent/neutral) to 1 (severe). Emotional language includes fear, outrage, insults, sensationalism, or pressure to react. " +
    "Factual skew means facts are selectively worded, juxtaposed, or emphasized in a way that materially changes their likely interpretation. " +
    "Context-omission risk means the supplied text itself signals that essential attribution, timeframe, denominator, uncertainty, or counter-context is absent. " +
    "Do not penalize ordinary clarity, accurately attributed quotations, or the mere presence of bad news. Findings must quote or closely identify language present in the text.\n\n" +
    text
  );
}
