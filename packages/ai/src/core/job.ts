import type { CoreInput } from "./types";

/** Durable job payload written by HTTP submission and consumed only by the worker. */
export interface CoreJobPayload {
  input: CoreInput;
  seed: number;
  allowReuse: boolean;
}

export function createCoreJobPayload(input: CoreInput, options: { allowReuse: boolean }) {
  return { input, seed: 20260910, allowReuse: options.allowReuse } satisfies CoreJobPayload;
}
