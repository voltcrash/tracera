import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createFixtureAnalysisPorts, FIXTURE_ARTICLE } from "@repo/ai/fixtures";
import {
  createRunAnalysis,
  createRunStore,
  createSnapshotStore,
  createSystemClock,
} from "@repo/ai/analysis";
import type { RunInput } from "@repo/ai/analysis/types";
import { analysisStorage, accessScope } from "../src/server/analysis-api.server";
import { analysisPolicy, analysisRunContext } from "../src/server/analysis-policy";
import { createWorkerTestEnv, signIn } from "./support/worker-env";

let harness: Awaited<ReturnType<typeof createWorkerTestEnv>>;
beforeAll(async () => {
  harness = await createWorkerTestEnv();
});
afterAll(async () => {
  await harness?.dispose();
});

test.each([
  { kind: "text", text: FIXTURE_ARTICLE },
  { kind: "link", url: "https://news.example/article" },
  {
    kind: "image",
    data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aStsAAAAASUVORK5CYII=",
    mimeType: "image/png",
    caption: null,
  },
] satisfies RunInput[])(
  "fixture $kind input runs the real focused engine offline",
  async (input) => {
    const { user } = await signIn(harness.env, "ada");
    const policy = analysisPolicy(harness.env, user.id);
    if (!policy.enabled) throw new Error(policy.message);
    const context = analysisRunContext(user.id, input, policy.policy);
    const repository = analysisStorage(harness.env).runs;
    const scope = accessScope(user);
    await repository.createRun({ context });
    const attempt = await repository.beginAttempt({
      scope,
      runId: context.runId,
      stage: "normalize_input",
      expectedVersion: 0,
    });
    const clock = createSystemClock();
    const fixture = createFixtureAnalysisPorts({ clock });
    const result = await createRunAnalysis({
      ...attempt,
      retrieval: { searchPorts: fixture.search },
    })(
      { input, seed: 20260910 },
      {
        context,
        signal: new AbortController().signal,
        ports: {
          ...fixture,
          clock,
          snapshots: createSnapshotStore({ repository, context }),
          runs: createRunStore({ repository, context }),
          audit: { sinkId: context.auditSinkId, record: async () => {} },
        },
      },
    );
    expect(result.status, JSON.stringify(result.issues)).toBe("partial");
    expect(result.report?.claims.length).toBeGreaterThan(0);
    expect(result.report?.decisions.length).toBeGreaterThan(0);
    expect(result.report?.scorecard?.factualScore).toBeNull();
    expect(
      (await repository.getRunProgress({ scope, runId: context.runId }))?.completedStages,
    ).toHaveLength(8);
  },
);
