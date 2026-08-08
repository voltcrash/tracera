import { z } from "zod";

export type JsonSchema = Record<string, unknown>;

export interface GenerateOptions {
  /** A provider-specific model override. */
  model?: string;
  /** Observability hook for structured-output validation and evaluation runs. */
  onStructuredOutputAttempt?: (attempt: StructuredOutputAttempt) => void;
}

export interface StructuredOutputAttempt {
  attempt: number;
  valid: boolean;
  error?: string;
}

/**
 * The only AI dependency pipeline code should need. Providers own their HTTP,
 * auth, and model details; callers only supply a prompt and its Zod contract.
 */
export interface AiProvider {
  generate<TSchema extends z.ZodType>(
    prompt: string,
    schema: TSchema,
    options?: GenerateOptions,
  ): Promise<z.output<TSchema>>;
  embed(text: string): Promise<number[]>;
}

export class StructuredOutputError extends Error {
  constructor(
    readonly provider: string,
    readonly attempts: readonly string[],
  ) {
    super(
      `${provider} returned output that did not match the requested schema after ${attempts.length} attempts.`,
    );
    this.name = "StructuredOutputError";
  }
}

export abstract class StructuredOutputProvider implements AiProvider {
  protected abstract readonly providerName: string;

  async generate<TSchema extends z.ZodType>(
    prompt: string,
    schema: TSchema,
    options?: GenerateOptions,
  ): Promise<z.output<TSchema>> {
    const jsonSchema = z.toJSONSchema(schema) as JsonSchema;
    const failures: string[] = [];

    // One initial attempt plus exactly one repair retry for invalid structure.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await this.generateRaw(prompt, jsonSchema, options);
      const result = this.parseOutput(raw, schema);

      if (result.success) {
        options?.onStructuredOutputAttempt?.({ attempt: attempt + 1, valid: true });
        return result.data;
      }

      failures.push(result.reason);
      options?.onStructuredOutputAttempt?.({
        attempt: attempt + 1,
        valid: false,
        error: result.reason,
      });
    }

    throw new StructuredOutputError(this.providerName, failures);
  }

  abstract embed(text: string): Promise<number[]>;

  protected abstract generateRaw(
    prompt: string,
    schema: JsonSchema,
    options?: GenerateOptions,
  ): Promise<string>;

  private parseOutput<TSchema extends z.ZodType>(
    raw: string,
    schema: TSchema,
  ):
    | { success: true; data: z.output<TSchema> }
    | { success: false; reason: string } {
    try {
      const json = JSON.parse(stripMarkdownCodeFence(raw));
      const parsed = schema.safeParse(json);

      if (parsed.success) {
        return { success: true, data: parsed.data };
      }

      return { success: false, reason: parsed.error.message };
    } catch (error) {
      return {
        success: false,
        reason: error instanceof Error ? error.message : "Response was not valid JSON.",
      };
    }
  }
}

function stripMarkdownCodeFence(raw: string) {
  const trimmed = raw.trim();

  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }

  return trimmed;
}
