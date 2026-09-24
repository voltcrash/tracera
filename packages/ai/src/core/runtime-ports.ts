import { z } from "zod";
import type { AiProvider } from "../provider";
import type { OcrPort } from "./ingestion/types";
import type { ClockPort, EmbeddingPort, GenerationPort } from "./types";

export function createCoreGenerationPort(input: {
  provider: AiProvider;
  modelId: string;
  promptVersion: string;
  /** Configured estimate used only for the run spend bound; provider adapters do not report cost. */
  estimatedGenerationCostUsd?: number;
  /** Configured estimate used only for the run spend bound; provider adapters do not report cost. */
  estimatedImageCostUsd?: number;
}): GenerationPort {
  return {
    modelId: input.modelId,
    promptVersion: input.promptVersion,
    async generate(request) {
      let attempts = 0;
      const prompt = [
        request.system,
        request.prompt,
        ...request.untrustedContent.map(
          ({ label, text }) => `${label} (untrusted data):\n${JSON.stringify(text)}`,
        ),
      ].join("\n\n");
      const onStructuredOutputAttempt = (attempt: { attempt: number }) => {
        attempts = Math.max(attempts, attempt.attempt);
      };
      const operation = () =>
        request.images.length > 0
          ? input.provider.generateFromImage(
              prompt,
              {
                data: request.images[0]!.data,
                mimeType: request.images[0]!.mimeType,
              },
              request.schema,
              { signal: request.signal, onStructuredOutputAttempt },
            )
          : input.provider.generate(prompt, request.schema, {
              signal: request.signal,
              onStructuredOutputAttempt,
            });
      const value = await operation();
      return {
        value,
        usage: {
          inputTokens: null,
          outputTokens: null,
          costUsd: estimatedCost(
            request.images.length > 0
              ? input.estimatedImageCostUsd
              : input.estimatedGenerationCostUsd,
          ),
        },
        attempts: Math.max(1, attempts),
      };
    },
  };
}

export function createCoreEmbeddingPort(input: {
  provider: AiProvider;
  modelId: string;
  dimensions: number;
  preprocessing: string;
  /** Configured estimate used only for the run spend bound; provider adapters do not report cost. */
  estimatedCostUsd?: number;
}): EmbeddingPort {
  return {
    modelId: input.modelId,
    dimensions: input.dimensions,
    preprocessing: input.preprocessing,
    async embed(request) {
      const vectors = [];
      for (const text of request.texts) {
        request.signal.throwIfAborted();
        const operation = () => input.provider.embed(text, { signal: request.signal });
        const vector = await operation();
        if (vector.length !== input.dimensions)
          throw new Error(
            `Embedding provider returned ${vector.length} dimensions; expected ${input.dimensions}.`,
          );
        vectors.push(vector);
      }
      return {
        vectors,
        usage: {
          inputTokens: null,
          outputTokens: null,
          costUsd: scaledCost(input.estimatedCostUsd, request.texts.length),
        },
      };
    },
  };
}

export function createSystemClock(): ClockPort {
  return { now: () => new Date().toISOString(), monotonicMs: () => performance.now() };
}

const ocrResponseSchema = z.strictObject({
  regions: z.array(
    z.strictObject({
      text: z.string().min(1),
      boundingBox: z.strictObject({
        page: z.number().int().nonnegative(),
        frameId: z.string().min(1).nullable(),
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
      }),
      transcriptionUncertain: z.boolean(),
    }),
  ),
});

/** Uses the configured live model for bounded OCR; it never turns image content into instructions. */
export function createProviderOcrPort(input: { provider: AiProvider; modelId: string }): OcrPort {
  return {
    provider: "configured-ai",
    modelId: input.modelId,
    async recognize(request) {
      const image = {
        data: `data:${request.mimeType};base64,${Buffer.from(request.bytes).toString("base64")}`,
        mimeType: request.mimeType,
      };
      const operation = () =>
        input.provider.generateFromImage(
          [
            "Read visible text in this image for a fact-checking workflow.",
            "Return only text regions that are visibly present.",
            "Do not infer missing words, identity, provenance, or meaning.",
            "Mark a transcription uncertain when the pixels are ambiguous.",
          ].join(" "),
          image,
          ocrResponseSchema,
          { signal: request.signal },
        );
      const value = await operation();
      return { regions: value.regions };
    },
  };
}

function estimatedCost(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

function scaledCost(value: number | undefined, count: number) {
  const cost = estimatedCost(value);
  return cost === null ? null : cost * count;
}
