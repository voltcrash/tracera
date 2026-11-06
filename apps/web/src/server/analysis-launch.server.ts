import type { ServerEnv } from "./env";
import type { AnalysisWorkflowParams } from "./workflow-params";

export const LAUNCH_RETRY_GRACE_MS = 30_000;
export const LAUNCH_RECOVERY_WINDOW_MS = 600_000;

export async function launchAnalysisWorkflow(
  env: ServerEnv,
  params: AnalysisWorkflowParams,
): Promise<"created" | "unknown"> {
  try {
    await env.ANALYSIS_WORKFLOW.create({ id: params.runId, params });
    return "created";
  } catch {
    try {
      const instance = await env.ANALYSIS_WORKFLOW.get(params.runId);
      await instance.status();
      return "created";
    } catch {
      return "unknown";
    }
  }
}
