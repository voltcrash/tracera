import type { ANALYSIS_CONTRACT_VERSION } from "@repo/contracts/analysis";
import type { AdapterRun, EvaluationDataset, EvaluationSplit } from "./schemas";

/** Which frozen contract an adapter's predictions are expressed in. */
export type EvaluationContractVersion = typeof ANALYSIS_CONTRACT_VERSION;

export interface EvaluationAdapterOptions {
  mode: "fixture" | "replay" | "live";
  split: EvaluationSplit | "all";
  seed: number;
  signal?: AbortSignal;
}

export interface EvaluationAdapter {
  readonly id: string;
  readonly version: string;
  readonly contractVersion: EvaluationContractVersion;
  evaluate(dataset: EvaluationDataset, options: EvaluationAdapterOptions): Promise<AdapterRun>;
}
