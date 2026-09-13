import { createHash } from "node:crypto";
import type { z } from "zod";
import type {
  EvidenceSource,
  ExtractedClaim,
  GroundZeroResult,
  NormalizedInput,
} from "./pipeline/types";
import type { AiProvider, AiRequestOptions, GenerateOptions, ImageInput } from "./provider";

export const OFFLINE_FIXTURE_IMAGE =
  "data:image/png;base64,dHJhY2VyYS1vZmZsaW5lLWltYWdlLWZpeHR1cmUtdjE=";
export const OFFLINE_FIXTURE_URL = "https://fixtures.tracera.example/articles/harbor-solar-library";
export const OFFLINE_INACCESSIBLE_URL =
  "https://fixtures.tracera.example/articles/inaccessible-source";

const fixtures = {
  coffee: {
    text: "A new study found that drinking coffee after 2pm doubles the risk of insomnia for all adults.",
    headline: "Coffee timing and insomnia risk",
    claim: "Drinking coffee after 2pm doubles the risk of insomnia for all adults.",
    verdict: "supported" as const,
  },
  conflict: {
    text: "Harbor City planted 10,000 trees during 2025, according to its annual report.",
    headline: "Conflicting Harbor City tree totals",
    claim: "Harbor City planted 10,000 trees during 2025.",
    verdict: "mixed" as const,
  },
  inaccessible: {
    text: "Northstar Agency published its annual safety review on 4 March 2026.",
    headline: "Northstar safety review publication",
    claim: "Northstar Agency published its annual safety review on 4 March 2026.",
    verdict: "unverified" as const,
  },
  link: {
    text: "Harbor Library opened a solar-powered reading room on 12 August 2026.",
    headline: "Harbor Library opens solar reading room",
    claim: "Harbor Library opened a solar-powered reading room on 12 August 2026.",
    verdict: "supported" as const,
  },
  image: {
    text: "River County opened three cooling centers on 9 July 2026.",
    headline: "River County opens three cooling centers",
    claim: "River County opened three cooling centers on 9 July 2026.",
    verdict: "supported" as const,
  },
  providerFailure: {
    text: "Fixture provider failure: Atlas Transit added two electric buses in 2026.",
    headline: "Fixture provider failure",
    claim: "Atlas Transit added two electric buses in 2026.",
    verdict: "unverified" as const,
  },
};

type FixtureId = keyof typeof fixtures;

export class FixtureUnavailableError extends Error {
  constructor(message = "No deterministic offline fixture is available for this submission.") {
    super(message);
    this.name = "FixtureUnavailableError";
  }
}

export class FixtureProviderError extends Error {
  constructor() {
    super("The deterministic provider-failure fixture was activated.");
    this.name = "FixtureProviderError";
  }
}

export class OfflineFixtureAiProvider implements AiProvider {
  async generate<TSchema extends z.ZodType>(
    prompt: string,
    schema: TSchema,
    options?: GenerateOptions,
  ): Promise<z.output<TSchema>> {
    options?.signal?.throwIfAborted();
    const fixture = fixtureFromText(prompt);
    if (fixture === "providerFailure") throw new FixtureProviderError();
    const item = fixtures[fixture];
    let output: unknown;
    if (prompt.startsWith("Decompose the following news text")) {
      output = {
        claims: [
          {
            id: `${fixture}-claim`,
            claimText: item.claim,
            claimType: "factual_assertion",
            checkability: "checkable",
            context: item.text,
          },
        ],
      };
    } else if (prompt.startsWith("Assess presentation and framing")) {
      output = {
        emotionalLanguageLevel: 0,
        factualSkewLevel: fixture === "conflict" ? 0.15 : 0,
        contextOmissionRisk: fixture === "inaccessible" ? 0.5 : 0.05,
        findings: fixture === "inaccessible" ? ["The fixture has no accessible source text."] : [],
      };
    } else if (prompt.startsWith("Write a headline")) {
      output = { headline: item.headline };
    } else if (prompt.startsWith("Evaluate this claim")) {
      const supportingSourceIds =
        fixture === "conflict" ? ["fixture:conflict:support"] : [`fixture:${fixture}:support`];
      const contradictingSourceIds = fixture === "conflict" ? ["fixture:conflict:contradict"] : [];
      output = {
        verdict: item.verdict,
        confidence: fixture === "conflict" ? 0.72 : 0.9,
        reasoning:
          fixture === "conflict"
            ? [
                "fixture:conflict:support reports 10,000 trees, while fixture:conflict:contradict reports 6,400.",
              ]
            : [`fixture:${fixture}:support directly reports the fixture claim.`],
        supportingSourceIds,
        contradictingSourceIds,
      };
    } else {
      throw new FixtureUnavailableError("No deterministic response matches this AI request.");
    }
    const parsed = schema.safeParse(output);
    if (!parsed.success)
      throw new FixtureUnavailableError(
        "The offline fixture does not satisfy the requested output contract.",
      );
    options?.onStructuredOutputAttempt?.({ attempt: 1, valid: true });
    return parsed.data;
  }

  async generateFromImage<TSchema extends z.ZodType>(
    _prompt: string,
    image: ImageInput,
    schema: TSchema,
    options?: GenerateOptions,
  ): Promise<z.output<TSchema>> {
    options?.signal?.throwIfAborted();
    if (image.data !== OFFLINE_FIXTURE_IMAGE) throw new FixtureUnavailableError();
    const parsed = schema.safeParse({ text: fixtures.image.text });
    if (!parsed.success)
      throw new FixtureUnavailableError(
        "The image fixture does not satisfy the requested output contract.",
      );
    options?.onStructuredOutputAttempt?.({ attempt: 1, valid: true });
    return parsed.data;
  }

  async embed(text: string, options?: AiRequestOptions): Promise<number[]> {
    options?.signal?.throwIfAborted();
    const digest = createHash("sha256").update(text.normalize("NFKC")).digest();
    const vector = Array.from({ length: 1024 }, (_, index) => {
      const byte = digest[index % digest.length]!;
      return Number((((byte - 127.5) / 127.5) * (1 + (index % 7) / 20)).toFixed(8));
    });
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return vector.map((value) => Number((value / magnitude).toFixed(10)));
  }
}

export function normalizeOfflineFixtureInput(input: {
  text?: string;
  url?: string;
  sourceUrl?: string;
  image?: string;
  imageMimeType?: string;
}): NormalizedInput {
  if (input.image) {
    if (input.image !== OFFLINE_FIXTURE_IMAGE) throw new FixtureUnavailableError();
    return {
      inputType: "image",
      rawInput: input.image,
      text: fixtures.image.text,
      imageMetadata: {
        mimeType: input.imageMimeType ?? "image/png",
        textExtractionProvider: "ai_provider",
      },
    };
  }
  const raw = input.url ?? input.sourceUrl ?? input.text?.trim();
  if (!raw) throw new FixtureUnavailableError();
  if (raw === OFFLINE_INACCESSIBLE_URL) {
    throw new FixtureUnavailableError(
      "The requested offline article fixture is intentionally inaccessible.",
    );
  }
  if (raw === OFFLINE_FIXTURE_URL) {
    return {
      inputType: "link",
      rawInput: raw,
      text: fixtures.link.text,
      title: fixtures.link.headline,
      sourceUrl: raw,
      sourceDomain: "fixtures.tracera.example",
      publishedAt: "2026-08-12T09:00:00.000Z",
      author: "Synthetic Desk",
    };
  }
  const fixture = fixtureFromText(raw);
  const item = fixtures[fixture];
  return { inputType: "text", rawInput: raw, text: item.text };
}

export function retrieveOfflineFixtureSources(
  claim: ExtractedClaim,
  submittedSource?: EvidenceSource,
): EvidenceSource[] {
  const fixture = fixtureFromText(`${claim.claimText} ${claim.context}`);
  if (fixture === "providerFailure") throw new FixtureProviderError();
  if (fixture === "inaccessible") return submittedSource ? [submittedSource] : [];
  const item = fixtures[fixture];
  const common = {
    type: "newsapi" as const,
    publishedAt: "2026-08-13T10:00:00.000Z",
    similarity: 0.98,
    credibility: 0.9,
  };
  const support: EvidenceSource = {
    ...common,
    id: `fixture:${fixture}:support`,
    title: `${item.headline} — supporting fixture`,
    url: `https://evidence.tracera.example/${fixture}/support`,
    canonicalUrl: `https://evidence.tracera.example/${fixture}/support`,
    publisher: "Synthetic Evidence Service",
    sourceDomain: "evidence.tracera.example",
    snippet: item.claim,
    publisherPublishedAt: "2026-08-13T10:00:00.000Z",
  };
  if (fixture !== "conflict") return [...(submittedSource ? [submittedSource] : []), support];
  return [
    ...(submittedSource ? [submittedSource] : []),
    support,
    {
      ...common,
      id: "fixture:conflict:contradict",
      title: "Harbor City audit reports 6,400 trees",
      url: "https://evidence.tracera.example/conflict/contradict",
      canonicalUrl: "https://evidence.tracera.example/conflict/contradict",
      publisher: "Synthetic Audit Office",
      sourceDomain: "audit.tracera.example",
      snippet: "The audited total was 6,400 trees planted during 2025, not 10,000.",
      publisherPublishedAt: "2026-08-14T10:00:00.000Z",
    },
  ];
}

export function retrieveOfflineFixtureArchiveHistory(
  sources: EvidenceSource[],
): GroundZeroResult["archiveHistory"] {
  return sources
    .filter((source) => source.url?.includes("tracera.example"))
    .slice(0, 1)
    .map((source) => ({
      url: source.canonicalUrl ?? source.url!,
      firstSeenAt: "2026-08-15T00:00:00.000Z",
      archivedUrl: `https://web.archive.org/web/20260815000000/${source.canonicalUrl ?? source.url}`,
    }));
}

function fixtureFromText(text: string): FixtureId {
  const normalized = text.toLowerCase();
  if (normalized.includes("fixture provider failure") || normalized.includes("atlas transit"))
    return "providerFailure";
  if (normalized.includes("10,000 trees") || normalized.includes("6,400 trees")) return "conflict";
  if (normalized.includes("northstar agency")) return "inaccessible";
  if (
    normalized.includes("solar-powered reading room") ||
    normalized.includes("harbor solar library")
  )
    return "link";
  if (normalized.includes("cooling centers")) return "image";
  if (normalized.includes("coffee after 2pm") && normalized.includes("insomnia")) return "coffee";
  throw new FixtureUnavailableError();
}
