import type { z } from "zod";
import type { AiProvider, GenerateOptions, ImageInput } from "./provider.js";

/** Combines independent generation and embedding providers behind one interface. */
export class CompositeAiProvider implements AiProvider {
  constructor(
    private readonly generationProvider: AiProvider,
    private readonly embeddingProvider: AiProvider,
  ) {}

  generate<TSchema extends z.ZodType>(
    prompt: string,
    schema: TSchema,
    options?: GenerateOptions,
  ): Promise<z.output<TSchema>> {
    return this.generationProvider.generate(prompt, schema, options);
  }

  generateFromImage<TSchema extends z.ZodType>(
    prompt: string,
    image: ImageInput,
    schema: TSchema,
    options?: GenerateOptions,
  ): Promise<z.output<TSchema>> {
    return this.generationProvider.generateFromImage(prompt, image, schema, options);
  }

  embed(text: string): Promise<number[]> {
    return this.embeddingProvider.embed(text);
  }
}
