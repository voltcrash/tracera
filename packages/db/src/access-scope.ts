import type { RunContext } from "@repo/contracts/analysis";

export type AnalysisVisibility = RunContext["visibility"];

export interface AnalysisAccessScope {
  tenantId: string;
  ownerUserId: string;
  visibility: AnalysisVisibility;
}
