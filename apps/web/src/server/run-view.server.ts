import { projectReport } from "@repo/ai/analysis/report-view";
import { apiUrl } from "@/lib/api";
import type { RunState } from "./analysis-api.server";

export function projectRunState(state: RunState) {
  return {
    progress: state.progress,
    report: state.report ? projectReport(state.report, apiUrl) : null,
  };
}

export type RunViewState = ReturnType<typeof projectRunState>;
