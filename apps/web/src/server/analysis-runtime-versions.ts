import { ANALYSIS_ENGINE_VERSION } from "@repo/ai/analysis";
import type { RunContext } from "@repo/contracts/analysis";

export function analysisRuntimeVersions(
  mode: "fixture" | "live",
  model: string,
  embeddingModel: string,
): RunContext["versions"] {
  return {
    engine: ANALYSIS_ENGINE_VERSION,
    prompt: mode === "fixture" ? "tracera-test-fixture-prompts-1.0.0" : "tracera-prompts-1.0.0",
    model,
    retriever: "tracera-retrieval-1.0.0",
    embedding: {
      model: embeddingModel,
      dimensions: 1024,
      preprocessing: "tracera-normalized-text-1.0.0",
    },
    calibration: null,
  };
}
