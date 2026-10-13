import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { analysisStorage, accessScope, startAnalysisRun } from "../src/server/analysis-api.server";
import { providerKeyStorage, saveProviderKeyForUser } from "../src/server/provider-keys.server";
import { createWorkerTestEnv, ORIGIN, signIn } from "./support/worker-env";
import type { SessionUser } from "../src/server/session";

export const personalRuntimeBounds = {
  ANALYSIS_MAX_EXTERNAL_REQUESTS: "120",
  ANALYSIS_MAX_DISCOVERY_QUERIES_PER_CLAIM: "12",
  ANALYSIS_MAX_FETCHED_CANDIDATES_PER_CLAIM: "20",
  ANALYSIS_MAX_PROVENANCE_HOPS: "3",
  ANALYSIS_MAX_TARGETED_RETRIEVAL_ROUNDS: "2",
  ANALYSIS_MAX_ELAPSED_MS: "120000",
  ANALYSIS_MAX_CONCURRENT_EXTERNAL_CALLS: "3",
  ANALYSIS_MAX_COST_USD: "1",
  AI_ESTIMATED_GENERATION_COST_USD: "0.01",
  AI_ESTIMATED_IMAGE_COST_USD: "0.02",
  AI_ESTIMATED_EMBEDDING_COST_USD: "0.0001",
};
let harness: Awaited<ReturnType<typeof createWorkerTestEnv>>;
let user: SessionUser;
let other: SessionUser;
beforeAll(async () => {
  harness = await createWorkerTestEnv({
    ...personalRuntimeBounds,
    ANALYSIS_MODE: "live",
    PROVIDER_KEYS_ENCRYPTION_KEY: JSON.stringify({
      activeVersion: 1,
      keys: { 1: btoa("x".repeat(32)) },
    }),
  });
  user = (await signIn(harness.env, "ada")).user;
  other = (await signIn(harness.env, "grace")).user;
  await saveProviderKeyForUser(
    harness.env,
    user.id,
    {
      provider: "openai",
      apiKey: "personal-secret-canary",
      model: "personal-model",
      embeddingModel: "personal-embedding",
    },
    async () => undefined,
  );
});
afterAll(async () => {
  await harness?.dispose();
});
const start = (owner: SessionUser = user) =>
  startAnalysisRun({
    env: harness.env,
    user: owner,
    request: new Request(ORIGIN),
    body: { text: "A claim to check." },
    idempotencyKey: crypto.randomUUID(),
  });

test("personal keys enable analysis without a platform provider or daily spend budget", async () => {
  const result = await start();
  expect(result.status).toBe(202);
  const context = await analysisStorage(harness.env).runs.getRunContext({
    scope: accessScope(user),
    runId: result.body.runId as string,
  });
  expect(context).toMatchObject({
    provider: { source: "user", provider: "openai" },
    versions: { model: "personal-model", embedding: { model: "personal-embedding" } },
  });
  expect(JSON.stringify(context)).not.toContain("personal-secret");
  expect(JSON.stringify(harness.created)).not.toContain("personal-secret");
  expect(
    await harness.env.DB.prepare("SELECT COUNT(*) AS count FROM analysis_daily_quotas").first(
      "count",
    ),
  ).toBe(0);
  expect(await start(other)).toMatchObject({ status: 503 });
});

test("admission never decrypts the active key and still enforces concurrency", async () => {
  await harness.env.DB.prepare(
    "UPDATE user_provider_keys SET ciphertext='unreadable-test-ciphertext' WHERE user_id=?",
  )
    .bind(user.id)
    .run();
  expect((await start()).status).toBe(202);
  expect(await start()).toMatchObject({ status: 429, body: { code: "user_concurrency_limited" } });
  await providerKeyStorage(harness.env).delete(user.id, "openai");
  expect((await start()).status).toBe(503);
});
