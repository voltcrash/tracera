import type { PortUsage } from "./types";

export class GenerationUsageError extends Error {
  constructor(
    error: unknown,
    readonly attempts: number,
    readonly usage: PortUsage,
  ) {
    super(error instanceof Error ? error.message : "Generation failed.");
    this.name = "GenerationUsageError";
  }
}
