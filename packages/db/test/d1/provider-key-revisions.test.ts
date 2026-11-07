import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { runContextExample } from "@repo/contracts/analysis";
import { createD1AnalysisRepository } from "../../src/repository.js";
import { createD1ProviderKeyRepository } from "../../src/provider-keys.js";
import { createTestRuntime, seedUser } from "./runtime.js";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
beforeEach(async () => {
  runtime = await createTestRuntime();
  await seedUser(runtime.db, "owner");
  await seedUser(runtime.db, "other");
});
afterEach(async () => {
  await runtime?.dispose();
});
const saved = {
  provider: "openai" as const,
  model: "model",
  embeddingModel: "embedding",
  baseUrl: null,
  embeddingProvider: null,
  embeddingBaseUrl: null,
  ciphertext: "ciphertext",
  iv: "iv",
  encryptionVersion: 1,
  fingerprint: "abcd",
};
const scope = { tenantId: "revisions", ownerUserId: "owner", visibility: "private" as const };
function context(id: string, revisionId: string) {
  return {
    ...structuredClone(runContextExample),
    ...scope,
    runId: id,
    provider: { source: "user" as const, provider: "openai" as const, revisionId },
    versions: {
      ...runContextExample.versions,
      model: saved.model,
      embedding: { ...runContextExample.versions.embedding, model: saved.embeddingModel },
    },
    budget: {
      ...runContextExample.budget,
      maxExternalRequests: 10,
      maxCostUsd: 1,
      maxElapsedMs: 60_000,
    },
  };
}

test("personal run binding verifies revision ownership and identity remains immutable", async () => {
  const keys = createD1ProviderKeyRepository(runtime.db);
  const revisionId = await keys.save("owner", saved);
  const other = await keys.save("other", saved);
  const runs = createD1AnalysisRepository({ database: runtime.db });
  await expect(runs.createRun({ context: context("wrong", other) })).rejects.toThrow(
    "owned key revision",
  );
  const wrongModel = context("wrong-model", revisionId);
  wrongModel.versions.model = "different-model";
  await expect(runs.createRun({ context: wrongModel })).rejects.toThrow("owned key revision");
  const ctx = context("bound", revisionId);
  await runs.createRun({ context: ctx });
  expect((await runs.getRunContext({ scope, runId: "bound" }))?.provider?.revisionId).toBe(
    revisionId,
  );
  await expect(
    runtime.db
      .prepare("UPDATE core_runs SET provider_key_revision_id=? WHERE run_id='bound'")
      .bind(other)
      .run(),
  ).rejects.toThrow("immutable");
  await keys.delete("owner", "openai");
  expect(await runs.createRun({ context: ctx })).toMatchObject({ created: false });
  await expect(runs.createRun({ context: context("deleted", revisionId) })).rejects.toThrow(
    "owned key revision",
  );
});

test("archived healthy revisions retain request admission, and rejection atomically refuses further charges", async () => {
  const keys = createD1ProviderKeyRepository(runtime.db);
  const revision = await keys.save("owner", saved);
  const runs = createD1AnalysisRepository({ database: runtime.db });
  const identity = { scope, runId: "requests" };
  await runs.createRun({ context: context(identity.runId, revision) });
  const attempt = await runs.beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  const input = { ...identity, fencingToken: attempt.fencingToken, estimatedCostUsd: 0.01 };
  await keys.save("owner", { ...saved, ciphertext: "new-key" });
  expect(await runs.reserveRunUsage(input)).toBe(true);
  await keys.markRejected("owner", revision);
  expect(await runs.reserveRunUsage(input)).toBe(false);
  await expect(
    runtime.db
      .prepare(
        "UPDATE core_runs SET usage_external_requests=usage_external_requests+1 WHERE run_id='requests'",
      )
      .run(),
  ).rejects.toThrow("revision is unavailable");
  expect((await runs.getRunUsage(identity))?.externalRequests).toBe(1);
  expect((await keys.activeMetadata("owner"))?.health).toBe("verified");
});

test("request admission racing rejection is charged only if it commits first", async () => {
  const keys = createD1ProviderKeyRepository(runtime.db);
  const revision = await keys.save("owner", saved);
  const runs = createD1AnalysisRepository({ database: runtime.db });
  const identity = { scope, runId: "race" };
  await runs.createRun({ context: context(identity.runId, revision) });
  const attempt = await runs.beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  const request = { ...identity, fencingToken: attempt.fencingToken, estimatedCostUsd: 0.01 };
  const [admitted] = await Promise.all([
    runs.reserveRunUsage(request),
    keys.markRejected("owner", revision),
  ]);
  expect(await runs.reserveRunUsage(request)).toBe(false);
  expect((await runs.getRunUsage(identity))?.externalRequests).toBe(admitted ? 1 : 0);
});

test("the migration preserves encrypted legacy keys without inventing run bindings", async () => {
  const legacy = await createTestRuntime({ migrationsThrough: "0012_artifact_lifecycle.sql" });
  try {
    await seedUser(legacy.db, "legacy-owner");
    await legacy.db
      .prepare(
        "INSERT INTO user_provider_keys(user_id,provider,model,embedding_model,ciphertext,iv,encryption_version,fingerprint,status,created_at,last_used_at) VALUES('legacy-owner','openai','model','embedding','old-cipher','old-iv',1,'abcd','active',10,20)",
      )
      .run();
    for (const source of ["user", "platform"]) {
      await legacy.db
        .prepare(
          "INSERT INTO core_runs(run_id,tenant_id,owner_user_id,visibility,input_hash,context_hash,as_of_time,execution_mode,versions,budget,cancellation,audit_sink_id,provider_source,provider,created_at,updated_at) VALUES(?,'revisions','legacy-owner','private',?,?,0,'live',?,?,?,'audit',?,'openai',0,0)",
        )
        .bind(
          source,
          runContextExample.inputHash,
          runContextExample.inputHash,
          JSON.stringify(runContextExample.versions),
          JSON.stringify({ ...runContextExample.budget, maxElapsedMs: 60_000 }),
          JSON.stringify(runContextExample.cancellation),
          source,
        )
        .run();
    }
    const sql = await readFile(
      new URL("../../migrations/0013_provider_key_revisions.sql", import.meta.url),
      "utf8",
    );
    await legacy.db.batch(
      sql
        .split("--> statement-breakpoint")
        .filter((part) => part.trim())
        .map((part) => legacy.db.prepare(part)),
    );
    const key = (await createD1ProviderKeyRepository(legacy.db).activeRecord("legacy-owner"))!;
    expect(key).toMatchObject({
      ciphertext: "old-cipher",
      iv: "old-iv",
      encryptionVersion: 1,
      isCurrent: true,
      health: "verified",
    });
    expect(key.id).toBeTruthy();
    expect(key.createdAt.getTime()).toBe(10);
    expect(key.lastUsedAt!.getTime()).toBe(20);
    const runs = createD1AnalysisRepository({ database: legacy.db });
    const legacyScope = { ...scope, ownerUserId: "legacy-owner" };
    expect(
      (await runs.getRunContext({ scope: legacyScope, runId: "user" }))?.provider,
    ).not.toHaveProperty("revisionId");
    for (const source of ["user", "platform"]) {
      const attempt = await runs.beginAttempt({
        scope: legacyScope,
        runId: source,
        stage: "normalize_input",
        expectedVersion: 0,
      });
      expect(
        await runs.reserveRunUsage({
          scope: legacyScope,
          runId: source,
          fencingToken: attempt.fencingToken,
          estimatedCostUsd: 0,
        }),
      ).toBe(source === "platform");
    }
  } finally {
    await legacy.dispose();
  }
});
