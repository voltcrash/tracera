import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { ProviderKeyRejectedError } from "@repo/ai";
import {
  acceptStoredSnapshots,
  createRunAnalysis,
  createRunStore,
  createSnapshotStore,
  createSystemClock,
  hashValue,
} from "@repo/ai/analysis";
import { createR2RawBlobStore } from "@repo/ai/analysis/ingestion";
import type { RunAnalysisInput } from "@repo/ai/analysis/types";
import { runReportSchema, type RunStatus } from "@repo/contracts/analysis";
import { analysisStorage, accessScope, isTerminalRunStatus } from "./analysis-api.server";
import { analysisControlConfig } from "./analysis-controls";
import { createWorkflowAnalysisPorts } from "./analysis-runtime";
import { resolveWorkflowProvider } from "./provider-selection.server";
import type { ServerEnv } from "./env";
import {
  ANALYSIS_WORKFLOW_RETRIES,
  WORKFLOW_SETTLEMENT_CONFIG,
  type AnalysisWorkflowParams,
} from "./workflow-params";

export type WorkflowDependencies = {
  storage?: ReturnType<typeof analysisStorage>;
  createPorts?: typeof createWorkflowAnalysisPorts;
};
type AnalysisOutcome = { status: RunStatus; reportUri: string | null; fencingToken: string | null };

export async function runAnalysisWorkflow(
  env: ServerEnv,
  params: AnalysisWorkflowParams,
  step: Pick<WorkflowStep, "do">,
  dependencies: WorkflowDependencies = {},
) {
  const storage = dependencies.storage ?? analysisStorage(env);
  const scope = accessScope({ id: params.ownerUserId });
  const identity = { scope, runId: params.runId };
  const context = await storage.runs.getRunContext(identity);
  if (!context) throw new NonRetryableError("The analysis run does not exist.");
  const blobStore = createR2RawBlobStore(
    env.BLOBS as unknown as Parameters<typeof createR2RawBlobStore>[0],
  );
  let outcome: AnalysisOutcome;
  try {
    outcome = await step.do(
      "analyze",
      {
        retries: { limit: ANALYSIS_WORKFLOW_RETRIES, delay: "2 seconds", backoff: "exponential" },
        timeout: context.budget.maxElapsedMs,
      },
      async (): Promise<AnalysisOutcome> => {
        const progress = await storage.runs.getRunProgress(identity);
        if (!progress) throw new NonRetryableError("The analysis run does not exist.");
        if (isTerminalRunStatus(progress.status))
          return { status: progress.status, reportUri: null, fencingToken: null };
        if (progress.cancellationRequested) {
          const attempt = await storage.runs.getActiveAttempt(identity);
          if (attempt) await storage.runs.acknowledgeCancellation({ ...identity, ...attempt });
          return { status: "canceled", reportUri: null, fencingToken: null };
        }
        const attempt = await storage.runs.beginAttempt({
          ...identity,
          stage: progress.stage,
          expectedVersion: progress.version,
        });
        const controller = new AbortController();
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(context.budget.maxElapsedMs),
        ]);
        const checkCancellation = async () => {
          if ((await storage.runs.getRunProgress(identity))?.cancellationRequested) {
            controller.abort(new Error("The analysis was canceled by its owner."));
            signal.throwIfAborted();
          }
        };
        try {
          const clock = createSystemClock();
          const ports = (dependencies.createPorts ?? createWorkflowAnalysisPorts)({
            env,
            context,
            clock,
            blobStore,
            ...(context.executionMode === "live"
              ? { resolvedProvider: await resolveWorkflowProvider(env, context) }
              : {}),
          });
          const runs = createRunStore({ repository: storage.runs, context });
          const result = await createRunAnalysis({
            ...attempt,
            retrieval: { searchPorts: ports.search },
          })((await storage.runs.getRunInput(identity)) as RunAnalysisInput, {
            context,
            signal,
            ports: {
              ...ports,
              clock,
              snapshots: acceptStoredSnapshots(
                createSnapshotStore({ repository: storage.runs, context, blobStore }),
              ),
              runs: {
                ...runs,
                async readCheckpoint(request) {
                  await checkCancellation();
                  return runs.readCheckpoint(request);
                },
                async checkpoint(request) {
                  await checkCancellation();
                  return runs.checkpoint(request);
                },
              },
              audit: {
                sinkId: context.auditSinkId,
                record: async (event) => console.info(JSON.stringify(event)),
              },
            },
          });
          await checkCancellation();
          ports.assertProviderAccepted();
          if (result.status === "failed" || !result.report)
            throw new Error("The engine did not complete a report.");
          const report = runReportSchema.parse(result.report);
          const pointer = await blobStore.put({
            snapshotId: params.runId,
            bytes: new TextEncoder().encode(JSON.stringify(report)),
            signal,
          });
          if (pointer.status !== "stored")
            throw new Error("The analysis report could not be stored.");
          return {
            status: report.status,
            reportUri: pointer.uri,
            fencingToken: attempt.fencingToken,
          };
        } catch (error) {
          if ((await storage.runs.getRunProgress(identity))?.cancellationRequested) {
            await storage.runs.acknowledgeCancellation({ ...identity, ...attempt });
            return { status: "canceled", reportUri: null, fencingToken: null };
          }
          if (error instanceof ProviderKeyRejectedError) {
            await storage.runs.failRun({
              ...identity,
              fencingToken: attempt.fencingToken,
              error: "provider_key_rejected",
            });
            throw new NonRetryableError(error.message);
          }
          // Workflow errors are persisted; never attach provider errors or request bodies.
          throw new Error("The analysis attempt failed before its report could be saved.");
        }
      },
    );
  } catch {
    outcome = await step.do(
      "fail",
      WORKFLOW_SETTLEMENT_CONFIG,
      async (): Promise<AnalysisOutcome> => {
        const progress = await storage.runs.getRunProgress(identity);
        if (progress && isTerminalRunStatus(progress.status))
          return { status: progress.status, reportUri: null, fencingToken: null };
        const attempt = await storage.runs.getActiveAttempt(identity);
        if (progress?.cancellationRequested && attempt) {
          await storage.runs.acknowledgeCancellation({ ...identity, ...attempt });
          return { status: "canceled", reportUri: null, fencingToken: null };
        }
        await storage.runs.failRun({
          ...identity,
          fencingToken: attempt?.fencingToken ?? null,
          error: "The analysis Workflow exhausted its retries.",
        });
        return { status: "failed", reportUri: null, fencingToken: null };
      },
    );
  }
  const status = await step.do(
    "finalize",
    WORKFLOW_SETTLEMENT_CONFIG,
    async (): Promise<RunStatus> => {
      const progress = await storage.runs.getRunProgress(identity);
      if (progress && isTerminalRunStatus(progress.status)) return progress.status;
      if (progress?.cancellationRequested) {
        const attempt = await storage.runs.getActiveAttempt(identity);
        if (attempt) await storage.runs.acknowledgeCancellation({ ...identity, ...attempt });
        return "canceled";
      }
      if (!outcome.reportUri || !outcome.fencingToken)
        throw new Error("The analysis report reference is missing.");
      const bytes = await blobStore.read(outcome.reportUri, new AbortController().signal);
      if (!bytes) throw new Error("The analysis report is unavailable.");
      const report = runReportSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      await storage.runs.finalize({
        ...identity,
        fencingToken: outcome.fencingToken,
        reportHash: hashValue(report),
        report,
      });
      return report.status;
    },
  );
  await step.do("release", WORKFLOW_SETTLEMENT_CONFIG, async () => {
    await storage.admission.finishAnalysisAdmission({
      userId: params.ownerUserId,
      ...params.admission,
      responseBody: { runId: params.runId, status, reportUrl: `/run/${params.runId}` },
      responseStatus: status === "failed" ? 503 : 200,
      idempotencyTtlSeconds: analysisControlConfig(env).idempotencyTtlSeconds,
    });
    return { runId: params.runId, status };
  });
  return { runId: params.runId, status };
}
