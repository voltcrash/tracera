import {
  completeRunReportExample,
  runContextExample,
  type RunContext,
  type RunReport,
} from "@repo/contracts/analysis";
import { createD1AnalysisRepository, type D1RepositoryOptions } from "@repo/db/d1";
import { createTestRuntime } from "@repo/db/test-runtime";
import { parseServerEnv, type ServerEnv } from "../../src/server/env";
import { authFor, readSessionUser } from "../../src/server/session.server";

export const ORIGIN = "http://localhost:3000";

/** A validated Worker env on fresh Miniflare D1 and R2 with a recording Workflow binding. */
export async function createWorkerTestEnv(overrides: Record<string, unknown> = {}) {
  const runtime = await createTestRuntime();
  const created: { id: string; params: unknown }[] = [];
  const workflow = {
    async create(options: { id: string; params: unknown }) {
      created.push(options);
      return { id: options.id };
    },
  };
  const env = parseServerEnv({
    DB: runtime.db,
    BLOBS: runtime.bucket,
    ANALYSIS_WORKFLOW: workflow,
    MODE: "dev",
    ANALYSIS_MODE: "fixture",
    DEV_AUTH_BYPASS: "true",
    BETTER_AUTH_SECRET: "synthetic-auth-secret-at-least-32-characters",
    ...overrides,
  });
  return { runtime, env, workflow, created, dispose: () => runtime.dispose() };
}

export async function signIn(env: ServerEnv, identity: "ada" | "grace") {
  const login = await authFor(env, new Request(ORIGIN)).handler(
    new Request(`${ORIGIN}/api/auth/dev-login?identity=${identity}`),
  );
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const user = await readSessionUser(env, new Request(ORIGIN, { headers: { cookie } }));
  if (!user) throw new Error("Dev sign-in did not create a session.");
  return { user, cookie };
}

/** Stores a finished run for the user, as the Workflow's finalize step will. */
export async function seedFinishedRun(env: ServerEnv, ownerUserId: string, runId: string) {
  const repository = createD1AnalysisRepository({
    database: env.DB,
    bucket: env.BLOBS,
  } as unknown as D1RepositoryOptions);
  const scope = { tenantId: `user:${ownerUserId}`, ownerUserId, visibility: "private" as const };
  const context: RunContext = { ...structuredClone(runContextExample), ...scope, runId };
  const report: RunReport = structuredClone(completeRunReportExample);
  report.runId = runId;
  report.replayManifest.runId = runId;
  for (const snapshot of report.snapshots) await repository.putSnapshot({ scope, snapshot });
  await repository.createRun({ context });
  const attempt = await repository.beginAttempt({
    scope,
    runId,
    stage: "score_report",
    expectedVersion: 0,
  });
  await repository.finalize({ scope, ...attempt, reportHash: context.inputHash, report });
  return report;
}
