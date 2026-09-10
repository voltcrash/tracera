import { z } from "zod";
import type { AiProvider } from "../provider";
import type { PromptAuditOptions } from "./extract-claims";
import type { NormalizedInput } from "./types";

const MAX_HEADLINE_CHARACTERS = 120;
const HEADLINE_SOURCE_CHARACTERS = 4_000;

const headlineSchema = z.object({
  headline: z.string().min(1).max(200),
});

/**
 * A trace is listed by what it is about, never by the URL or base64 blob that
 * was submitted. A publisher-authored title is preferred when the link carried
 * one; everything else is summarized by the model.
 */
export async function writeHeadline(
  provider: AiProvider,
  input: NormalizedInput,
  audit?: PromptAuditOptions,
): Promise<string> {
  const publisherTitle = tidy(input.title ?? "");
  if (publisherTitle) return publisherTitle;

  const prompt = buildHeadlinePrompt(input.text);
  audit?.onPrompt?.({ stage: "headline", prompt });
  try {
    const result = await provider.generate(prompt, headlineSchema, {
      signal: audit?.signal,
      onStructuredOutputAttempt: (attempt) =>
        audit?.onStructuredOutputAttempt?.({ stage: "headline", ...attempt }),
    });
    const headline = tidy(result.headline);
    if (headline) return headline;
  } catch (error) {
    audit?.signal?.throwIfAborted();
    console.warn("Could not write a headline for this trace", error);
  }
  return fallbackHeadline(input);
}

export function buildHeadlinePrompt(text: string) {
  return (
    `Write a headline for the following submission so a reader can recognise it in a list.\n\n${text.slice(0, HEADLINE_SOURCE_CHARACTERS)}\n\n` +
    "Use at most 12 words in sentence case. State only what the submission says, using its own names, places, and numbers. " +
    "Do not judge, rate, or hedge the submission, and do not add detail that is not present."
  );
}

function fallbackHeadline(input: NormalizedInput) {
  const sentence = tidy(input.text.split(/(?<=[.!?])\s/)[0] ?? "");
  if (sentence) return sentence;
  if (input.sourceDomain) return `Untitled trace from ${input.sourceDomain}`;
  return input.inputType === "image" ? "Untitled image trace" : "Untitled trace";
}

function tidy(value: string) {
  const headline = value
    .replace(/\s+/g, " ")
    .replace(/^["'“”]|["'“”]$/g, "")
    .trim();
  if (!headline) return "";
  if (headline.length <= MAX_HEADLINE_CHARACTERS) return headline;
  const cut = headline.slice(0, MAX_HEADLINE_CHARACTERS);
  return `${cut.slice(0, cut.lastIndexOf(" ")) || cut}…`;
}
