/*
 * Deterministic stand-in for a generation provider in claim-inventory fixtures.
 * It replays hand-written model output and lives outside src/ so no production
 * entry point can select it.
 */
import {
  CLAIM_EXTRACTION_PROMPT_VERSION,
  CLAIM_EXTRACTION_SCHEMA_NAME,
  type ChunkExtraction,
  type ChunkPayload,
  type RawClaim,
} from "../../src/analysis/claims/index.js";
import type { GenerationPort, GenerationRequest } from "../../src/analysis/types.js";

export interface ScriptedQuote {
  quote: string;
  /** Text identifying the segment to cite; defaults to the quote itself. */
  in?: string;
  /** 1-based choice among identical segments, in document order. */
  occurrence?: number;
}

export interface ScriptedClaim extends Omit<
  RawClaim,
  "sourceQuotes" | "attribution" | "referents" | "localId"
> {
  localId?: string;
  sourceQuotes: Array<string | ScriptedQuote>;
  attribution: {
    kind: RawClaim["attribution"]["kind"];
    attributedTo: string | null;
    quote: string | ScriptedQuote | null;
  };
  referents: Array<{ mention: string; referent: string; antecedent: string | ScriptedQuote }>;
}

export interface ClaimScript {
  segments: Array<{
    text: string;
    disposition: ChunkExtraction["segments"][number]["disposition"];
    reason: string | null;
  }>;
  claims: ScriptedClaim[];
}

export type ScriptedGeneration = GenerationPort & {
  readonly payloads: ChunkPayload[];
};

export function createScriptedClaimGeneration(
  script: ClaimScript,
  options: {
    failOnCalls?: number[];
    beforeResponse?: (call: number) => void;
    usage?: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  } = {},
): ScriptedGeneration {
  const payloads: ChunkPayload[] = [];
  return {
    modelId: "scripted-claim-fixture",
    promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION,
    payloads,
    async generate<Value>(request: GenerationRequest<Value>) {
      request.signal.throwIfAborted();
      if (request.schemaName !== CLAIM_EXTRACTION_SCHEMA_NAME) {
        throw new Error(`Scripted generation cannot answer ${request.schemaName}.`);
      }
      const payload = JSON.parse(request.untrustedContent[0]!.text) as ChunkPayload;
      payloads.push(payload);
      const call = payloads.length;
      options.beforeResponse?.(call);
      request.signal.throwIfAborted();
      if (options.failOnCalls?.includes(call)) throw new Error("scripted provider outage");
      return {
        value: request.schema.parse(respond(script, payload)),
        usage: options.usage ?? { inputTokens: null, outputTokens: null, costUsd: null },
        attempts: 1,
      };
    },
  };
}

function respond(script: ClaimScript, payload: ChunkPayload): ChunkExtraction {
  const owned = payload.segments.filter((segment) => segment.role === "extract");
  const find = (reference: string | ScriptedQuote) => {
    const {
      quote,
      in: anchor,
      occurrence,
    } = typeof reference === "string"
      ? { quote: reference, in: undefined, occurrence: undefined }
      : reference;
    const needle = anchor ?? quote;
    const segment =
      occurrence !== undefined
        ? payload.segments.filter((candidate) => candidate.text.includes(needle))[occurrence - 1]
        : (owned.find((candidate) => candidate.text.includes(needle)) ??
          payload.segments.find((candidate) => candidate.text.includes(needle)));
    return segment ? { segmentId: segment.id, quote, owned: segment.role === "extract" } : null;
  };

  const claims: ChunkExtraction["claims"] = [];
  const cited = new Set<string>();
  script.claims.forEach((claim, index) => {
    const sourceQuotes = claim.sourceQuotes.map(find);
    if (
      sourceQuotes.some((quote) => quote === null) ||
      !sourceQuotes.some((quote) => quote!.owned)
    ) {
      return;
    }
    const fallback = sourceQuotes[0]!;
    const reference = (value: string | ScriptedQuote) => {
      const found = find(value);
      return found
        ? { segmentId: found.segmentId, quote: found.quote }
        : { segmentId: fallback.segmentId, quote: typeof value === "string" ? value : value.quote };
    };
    for (const quote of sourceQuotes) cited.add(quote!.segmentId);
    claims.push({
      ...claim,
      localId: claim.localId ?? `c${index + 1}`,
      sourceQuotes: sourceQuotes.map((quote) => ({
        segmentId: quote!.segmentId,
        quote: quote!.quote,
      })),
      attribution: {
        kind: claim.attribution.kind,
        attributedTo: claim.attribution.attributedTo,
        quote: claim.attribution.quote === null ? null : reference(claim.attribution.quote),
      },
      referents: claim.referents.map((referent) => ({
        mention: referent.mention,
        referent: referent.referent,
        antecedent: reference(referent.antecedent),
      })),
    });
  });

  const segments: ChunkExtraction["segments"] = [];
  for (const segment of owned) {
    const scripted = script.segments.find((entry) => segment.text.includes(entry.text));
    if (scripted) {
      segments.push({
        segmentId: segment.id,
        disposition: scripted.disposition,
        reason: scripted.reason,
      });
    } else if (cited.has(segment.id)) {
      segments.push({ segmentId: segment.id, disposition: "factual_claim", reason: null });
    }
  }
  return { segments, claims };
}

/** Builds a scripted claim with neutral defaults for the fields a fixture does not vary. */
export function scriptedClaim(
  claim: Partial<ScriptedClaim> & Pick<ScriptedClaim, "text" | "sourceQuotes">,
): ScriptedClaim {
  return {
    retrievalText: claim.text,
    proposition: {
      subject: claim.text.split(" ")[0]!,
      predicate: "states",
      object: claim.text,
      qualifiers: [],
    },
    attribution: { kind: "direct_assertion", attributedTo: null, quote: null },
    negated: false,
    quantities: [],
    time: { statedText: null },
    place: null,
    referents: [],
    unresolvedMentions: [],
    checkability: "checkable",
    material: true,
    parentLocalId: null,
    ...claim,
  };
}
