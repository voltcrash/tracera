import {
  createD1MaintenanceRepository,
  StaleWorkerError,
  type D1RepositoryOptions,
} from "@repo/db";
import type { AnalysisAccessScope } from "@repo/db";
import { analysisStorage, isTerminalRunStatus } from "./analysis-api.server";
import { CANCELLATION_GRACE_MS } from "./analysis-cancellation.server";
import { analysisControlConfig } from "./analysis-controls";
import type { ServerEnv } from "./env";
import type { AnalysisWorkflowParams } from "./workflow-params";

type RunRow = {
  run_id: string;
  tenant_id: string;
  owner_user_id: string;
  visibility: AnalysisAccessScope["visibility"];
  status: string;
  cancellation: string;
};

export async function scheduledMaintenance(env: ServerEnv, now = Date.now()) {
  const storage = analysisStorage(env, () => now);
  const controls = analysisControlConfig(env);
  const counts = { failedRuns: 0, canceledRuns: 0, admissionsReleased: 0, workflowStatusErrors: 0 };
  let after = "";
  while (true) {
    const page = await env.DB.prepare(
      `SELECT run_id,tenant_id,owner_user_id,visibility,status,cancellation FROM core_runs AS run
      WHERE run_id>? AND (status IN ('queued','running') OR (status='canceled'
        AND created_at >= (SELECT MIN(created_at) FROM analysis_leases WHERE user_id=run.owner_user_id AND released_at IS NULL)))
      ORDER BY run_id LIMIT 100`,
    )
      .bind(after)
      .all<RunRow>();
    for (const row of page.results) {
      const scope = rowScope(row);
      const identity = { scope, runId: row.run_id };
      let instance: WorkflowInstance;
      let state: Awaited<ReturnType<WorkflowInstance["status"]>>;
      try {
        instance = await env.ANALYSIS_WORKFLOW.get(row.run_id);
        state = await instance.status();
      } catch {
        counts.workflowStatusErrors++;
        console.error("Could not inspect analysis Workflow", { runId: row.run_id });
        continue;
      }
      const cancellation = JSON.parse(row.cancellation) as {
        requested: boolean;
        requestedAt: string | null;
      };
      try {
        if (
          cancellation.requested &&
          (["complete", "errored", "terminated"].includes(state.status) ||
            now - Date.parse(cancellation.requestedAt ?? "") >= CANCELLATION_GRACE_MS)
        ) {
          if (!["complete", "errored", "terminated"].includes(state.status))
            await instance.terminate();
          if (await storage.runs.acknowledgeStoppedCancellation(identity)) counts.canceledRuns++;
        } else if (["errored", "terminated"].includes(state.status)) {
          const attempt = await storage.runs.getActiveAttempt(identity);
          await storage.runs.failRun({
            ...identity,
            fencingToken: attempt?.fencingToken ?? null,
            error: "The analysis Workflow stopped before the run finished.",
          });
          counts.failedRuns++;
        }
      } catch (error) {
        if (!(error instanceof StaleWorkerError)) throw error;
      }
    }
    if (page.results.length < 100) break;
    after = page.results.at(-1)!.run_id;
  }

  after = "";
  while (true) {
    const page =
      await env.DB.prepare(`SELECT run_id,tenant_id,owner_user_id,visibility,status,cancellation FROM core_runs AS run
      WHERE status IN ('complete','partial','unavailable','failed','canceled') AND run_id>?
      AND created_at >= (SELECT MIN(created_at) FROM analysis_leases WHERE user_id=run.owner_user_id AND released_at IS NULL)
      ORDER BY run_id LIMIT 100`)
        .bind(after)
        .all<RunRow>();
    for (const row of page.results) {
      if (!isTerminalRunStatus(row.status)) continue;
      const input = (await storage.runs.getRunInput({
        scope: rowScope(row),
        runId: row.run_id,
      })) as { admission?: AnalysisWorkflowParams["admission"] } | null;
      if (!input?.admission) continue;
      const admission = input.admission;
      const held = await env.DB.prepare(
        "SELECT id FROM analysis_leases WHERE id=? AND user_id=? AND released_at IS NULL",
      )
        .bind(admission.leaseId, row.owner_user_id)
        .first();
      if (!held) continue;
      await storage.admission.finishAnalysisAdmission({
        userId: row.owner_user_id,
        ...admission,
        responseBody: { runId: row.run_id, status: row.status, reportUrl: `/run/${row.run_id}` },
        responseStatus: row.status === "failed" ? 503 : 200,
        idempotencyTtlSeconds: controls.idempotencyTtlSeconds,
      });
      counts.admissionsReleased++;
    }
    if (page.results.length < 100) break;
    after = page.results.at(-1)!.run_id;
  }
  const expired = await createD1MaintenanceRepository({
    database: env.DB,
    now: () => now,
  } as unknown as D1RepositoryOptions).purgeExpired({
    rateWindowSeconds: controls.rateWindowSeconds,
  });
  return { ...counts, ...expired };
}

function rowScope(row: RunRow): AnalysisAccessScope {
  return { tenantId: row.tenant_id, ownerUserId: row.owner_user_id, visibility: row.visibility };
}
