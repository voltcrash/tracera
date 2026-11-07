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
import { publishPreparedReport } from "./report-publication.server";
import {
  launchAnalysisWorkflow,
  LAUNCH_RECOVERY_WINDOW_MS,
  LAUNCH_RETRY_GRACE_MS,
} from "./analysis-launch.server";

type RunRow = {
  run_id: string;
  tenant_id: string;
  owner_user_id: string;
  visibility: AnalysisAccessScope["visibility"];
  status: string;
  cancellation: string;
  launch_status: "not_required" | "pending" | "created" | "unknown";
  launch_attempted_at: number | null;
  created_at: number;
  launch_admission: string | null;
};

export async function scheduledMaintenance(env: ServerEnv, now = Date.now()) {
  const storage = analysisStorage(env, () => now);
  const controls = analysisControlConfig(env);
  const counts = {
    failedRuns: 0,
    canceledRuns: 0,
    admissionsReleased: 0,
    workflowStatusErrors: 0,
    launchesRecovered: 0,
    reportsRecovered: 0,
    reportRecoveryErrors: 0,
  };
  let after = "";
  while (true) {
    const page = await env.DB.prepare(
      `SELECT run_id,tenant_id,owner_user_id,visibility,status,cancellation,launch_status,launch_attempted_at,created_at,launch_admission FROM core_runs AS run
      WHERE run_id>? AND (status IN ('queued','running') OR (status='canceled'
        AND created_at >= (SELECT MIN(created_at) FROM analysis_leases WHERE user_id=run.owner_user_id AND released_at IS NULL)))
      ORDER BY run_id LIMIT 100`,
    )
      .bind(after)
      .all<RunRow>();
    for (const row of page.results) {
      const scope = rowScope(row);
      const identity = { scope, runId: row.run_id };
      const cancellation = JSON.parse(row.cancellation) as {
        requested: boolean;
        requestedAt: string | null;
      };
      if (!cancellation.requested && (await storage.runs.getPreparedReport(identity))) {
        try {
          if (await publishPreparedReport(env, storage, identity)) counts.reportsRecovered++;
        } catch (error) {
          if (!(error instanceof StaleWorkerError)) {
            counts.reportRecoveryErrors++;
            console.error("Could not publish prepared analysis report", { runId: row.run_id });
          }
        }
        continue;
      }
      let instance: WorkflowInstance;
      let state: Awaited<ReturnType<WorkflowInstance["status"]>>;
      try {
        instance = await env.ANALYSIS_WORKFLOW.get(row.run_id);
        state = await instance.status();
      } catch {
        counts.workflowStatusErrors++;
        if (
          row.status === "queued" &&
          row.launch_status !== "not_required" &&
          !cancellation.requested &&
          now - (row.launch_attempted_at ?? row.created_at) >= LAUNCH_RETRY_GRACE_MS
        ) {
          try {
            const outcome = await recoverQueuedLaunch(env, storage, row, now);
            if (outcome === "created") counts.launchesRecovered++;
            if (outcome === "failed") counts.failedRuns++;
          } catch (error) {
            if (!(error instanceof StaleWorkerError))
              console.error("Could not reconcile analysis launch", { runId: row.run_id });
          }
        } else console.error("Could not inspect analysis Workflow", { runId: row.run_id });
        continue;
      }
      if (row.launch_status === "pending" || row.launch_status === "unknown") {
        await storage.runs.recordWorkflowLaunch({ ...identity, status: "created" });
      }
      try {
        if (
          row.status === "queued" &&
          row.launch_status !== "not_required" &&
          !cancellation.requested &&
          now - row.created_at >= LAUNCH_RECOVERY_WINDOW_MS
        ) {
          const settled = await storage.runs.failRun({
            ...identity,
            fencingToken: null,
            error: "The analysis Workflow did not begin before its launch window expired.",
          });
          counts[settled === "canceled" ? "canceledRuns" : "failedRuns"]++;
          continue;
        }
        if (
          cancellation.requested &&
          (["complete", "errored", "terminated"].includes(state.status) ||
            now - Date.parse(cancellation.requestedAt ?? "") >= CANCELLATION_GRACE_MS)
        ) {
          if (!["complete", "errored", "terminated"].includes(state.status))
            await instance.terminate();
          if (await storage.runs.acknowledgeStoppedCancellation(identity)) counts.canceledRuns++;
        } else if (["complete", "errored", "terminated"].includes(state.status)) {
          const attempt = await storage.runs.getActiveAttempt(identity);
          const settled = await storage.runs.failRun({
            ...identity,
            fencingToken: attempt?.fencingToken ?? null,
            error: "The analysis Workflow stopped before the run finished.",
          });
          counts[settled === "canceled" ? "canceledRuns" : "failedRuns"]++;
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
      await env.DB.prepare(`SELECT run_id,tenant_id,owner_user_id,visibility,status,cancellation,launch_admission FROM core_runs AS run
      WHERE status IN ('complete','partial','unavailable','failed','canceled') AND run_id>?
      AND created_at >= (SELECT MIN(created_at) FROM analysis_leases WHERE user_id=run.owner_user_id AND released_at IS NULL)
      ORDER BY run_id LIMIT 100`)
        .bind(after)
        .all<RunRow>();
    for (const row of page.results) {
      if (!isTerminalRunStatus(row.status)) continue;
      const admission = await runAdmission(storage, row);
      if (!admission) continue;
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

async function recoverQueuedLaunch(
  env: ServerEnv,
  storage: ReturnType<typeof analysisStorage>,
  row: RunRow,
  now: number,
): Promise<"created" | "unknown" | "failed"> {
  const identity = { scope: rowScope(row), runId: row.run_id };
  const fail = async () => {
    await storage.runs.failRun({
      ...identity,
      fencingToken: null,
      error: "The analysis Workflow could not be launched before its admission expired.",
    });
    return "failed" as const;
  };
  if (now - row.created_at >= LAUNCH_RECOVERY_WINDOW_MS) return fail();
  const admission = await runAdmission(storage, row);
  if (!admission) return fail();
  const lease = await env.DB.prepare(
    "SELECT id FROM analysis_leases WHERE id=? AND user_id=? AND endpoint=? AND idempotency_key=? AND released_at IS NULL AND (expires_at>? OR run_id=?)",
  )
    .bind(
      admission.leaseId,
      row.owner_user_id,
      admission.endpoint,
      admission.idempotencyKey,
      now,
      row.run_id,
    )
    .first();
  if (!lease) return fail();
  const status = await launchAnalysisWorkflow(env, {
    runId: row.run_id,
    ownerUserId: row.owner_user_id,
    admission,
  });
  await storage.runs.recordWorkflowLaunch({ ...identity, status });
  return status;
}

async function runAdmission(
  storage: ReturnType<typeof analysisStorage>,
  row: RunRow,
): Promise<AnalysisWorkflowParams["admission"] | undefined> {
  if (row.launch_admission)
    return JSON.parse(row.launch_admission) as AnalysisWorkflowParams["admission"];
  const input = (await storage.runs.getRunInput({ scope: rowScope(row), runId: row.run_id })) as {
    admission?: AnalysisWorkflowParams["admission"];
  } | null;
  return input?.admission;
}
