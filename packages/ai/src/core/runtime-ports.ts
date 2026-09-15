import { createHash } from "node:crypto";
import type { AiProvider } from "../provider.js";
import { createDocumentAcquisitionPort } from "./ingestion/index.js";
import type { AuditPort, ClockPort, EmbeddingPort, GenerationPort } from "./types.js";

export function createCoreGenerationPort(input: {
  provider: AiProvider;
  modelId: string;
  promptVersion: string;
  withExternalCall?: <Value>(identity: string, operation: () => Promise<Value>) => Promise<Value>;
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
      const value = input.withExternalCall
        ? await input.withExternalCall(`${request.schemaName}:${prompt}`, operation)
        : await operation();
      return {
        value,
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
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
  withExternalCall?: <Value>(identity: string, operation: () => Promise<Value>) => Promise<Value>;
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
        const vector = input.withExternalCall
          ? await input.withExternalCall(`embedding:${text}`, operation)
          : await operation();
        if (vector.length !== input.dimensions)
          throw new Error(
            `Embedding provider returned ${vector.length} dimensions; expected ${input.dimensions}.`,
          );
        vectors.push(vector);
      }
      return { vectors, usage: { inputTokens: null, outputTokens: null, costUsd: null } };
    },
  };
}

export function createSystemClock(): ClockPort {
  return { now: () => new Date().toISOString(), monotonicMs: () => performance.now() };
}

export function createOperationalAudit(sinkId: string): AuditPort {
  return {
    sinkId,
    record: async (event) => {
      console.info(JSON.stringify({ sinkId, ...event }));
    },
  };
}

export function createRuntimeDocumentPort(clock: ClockPort, fetchImplementation?: typeof fetch) {
  return createDocumentAcquisitionPort({
    now: () => clock.now(),
    monotonicMs: () => clock.monotonicMs(),
    ...(fetchImplementation ? { safeFetchOptions: { fetchImplementation } } : {}),
  });
}

export type SpendAdmission = { allowed: true } | { allowed: false; retryAt: string };

/**
 * Reservation IDs derive from the run and the exact call, so a retried job reuses the
 * reservation it already holds instead of charging the shared budget a second time.
 */
export function createReservedExternalCall(input: {
  runId: string;
  estimatedUsd: number;
  reserve(request: { reservationId: string; estimatedUsd: number }): Promise<SpendAdmission>;
  onReserved(reservationId: string): void;
}) {
  return async <Value>(identity: string, operation: () => Promise<Value>) => {
    const reservationId = deterministicReservationId(`${input.runId}:${identity}`);
    const admission = await input.reserve({ reservationId, estimatedUsd: input.estimatedUsd });
    if (!admission.allowed)
      throw new Error(`Provider spend limit is open until ${admission.retryAt}.`);
    input.onReserved(reservationId);
    return operation();
  };
}

export function deterministicReservationId(value: string) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}
