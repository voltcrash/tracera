import type { CORE_V2_CONTRACT_VERSION } from "@repo/contracts/core-v2";
import type { AdapterRun, EvaluationDataset, EvaluationSplit } from "./schemas.js";

/** Which frozen contract an adapter's predictions are expressed in. */
export type EvaluationContractVersion = typeof CORE_V2_CONTRACT_VERSION | "legacy-v1";

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
