import type { AdapterRun, EvaluationDataset, EvaluationSplit } from "./schemas.js";

export interface EvaluationAdapterOptions {
  mode: "fixture" | "replay" | "live";
  split: EvaluationSplit | "all";
  seed: number;
  signal?: AbortSignal;
}

export interface EvaluationAdapter {
  readonly id: string;
  readonly version: string;
  evaluate(dataset: EvaluationDataset, options: EvaluationAdapterOptions): Promise<AdapterRun>;
}
