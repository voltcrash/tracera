import { analysisStorage, accessScope } from "./analysis-api.server";
import { analysisControlConfig } from "./analysis-controls";
import type { ServerEnv } from "./env";
import type { AnalysisWorkflowParams } from "./workflow-params";

export const CANCELLATION_GRACE_MS = 5_000;

export async function terminateCanceledRun(
  env: ServerEnv,
  ownerUserId: string,
  runId: string,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  await sleep(CANCELLATION_GRACE_MS);
  const storage = analysisStorage(env);
  const identity = { scope: accessScope({ id: ownerUserId }), runId };
  const progress = await storage.runs.getRunProgress(identity);
  if (!progress?.cancellationRequested) return;
  const instance = await env.ANALYSIS_WORKFLOW.get(runId);
  const state = await instance.status();
  if (!["complete", "errored", "terminated"].includes(state.status)) await instance.terminate();
  await storage.runs.acknowledgeStoppedCancellation(identity);
  const input = (await storage.runs.getRunInput(identity)) as {
    admission: AnalysisWorkflowParams["admission"];
  };
  await storage.admission.finishAnalysisAdmission({
    userId: ownerUserId,
    ...input.admission,
    responseBody: { runId, status: "canceled", reportUrl: `/run/${runId}` },
    responseStatus: 200,
    idempotencyTtlSeconds: analysisControlConfig(env).idempotencyTtlSeconds,
  });
}
