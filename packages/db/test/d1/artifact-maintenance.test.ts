import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { completeRunReportExample, runContextExample } from "@repo/contracts/analysis";
import {
  ARTIFACT_GRACE_MS as GRACE,
  sweepOrphanArtifacts,
} from "../../src/artifact-maintenance.js";
import { D1PayloadStore, hashJson, sha256 } from "../../src/payloads.js";
import { createD1AnalysisRepository } from "../../src/repository.js";
import { createD1AdmissionRepository } from "../../src/admission.js";
import { createTestRuntime, seedUser } from "./runtime.js";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
let base: number;
beforeEach(async () => {
  runtime = await createTestRuntime();
  base = Date.now() + 60_000;
});
afterEach(async () => {
  await runtime?.dispose();
});
const scope = { tenantId: "artifacts", ownerUserId: "owner", visibility: "private" as const };
const sweep = (now: number, pageSize = 100) =>
  sweepOrphanArtifacts({ database: runtime.db, bucket: runtime.bucket, now, pageSize });
async function upload() {
  return new D1PayloadStore(runtime.bucket).encode(
    { text: crypto.randomUUID() },
    "reports",
    0,
    true,
  );
}
async function retainInput(uri: string, runId: string, now: number) {
  const runs = createD1AnalysisRepository({ database: runtime.db, now: () => now });
  await runs.createRun({ context: { ...structuredClone(runContextExample), ...scope, runId } });
  await runs.failRun({ scope, runId, fencingToken: null, error: "Stopped" });
  await runtime.db
    .prepare(
      "UPDATE core_runs SET input_json=NULL,input_blob_uri=?,input_payload_hash=? WHERE run_id=?",
    )
    .bind(uri, `sha256:${uri.split("/").at(-2)}`, runId)
    .run();
}

test("new uploads need a full grace period and two separated orphan observations; legacy keys are retained", async () => {
  const payload = await upload();
  const rawKey = `uploads/snapshots/orphan/${"a".repeat(64)}/${crypto.randomUUID()}`;
  await runtime.bucket.put(rawKey, "unreferenced capture");
  const legacy = `payloads/reports/${"b".repeat(64)}`;
  await runtime.bucket.put(legacy, "legacy");
  expect(await sweep(base)).toMatchObject({ artifactsMarked: 0, artifactsDeleted: 0 });
  expect(await sweep(base + GRACE + 1)).toMatchObject({ artifactsMarked: 2, artifactsDeleted: 0 });
  expect(await sweep(base + GRACE + 2)).toMatchObject({ artifactsDeleted: 0 });
  expect(await sweep(base + GRACE * 2 + 2)).toMatchObject({ artifactsDeleted: 2 });
  expect(await runtime.bucket.get(payload.blobUri!.slice(5))).toBeNull();
  expect(await runtime.bucket.get(rawKey)).toBeNull();
  expect(await runtime.bucket.get(legacy)).not.toBeNull();
});

test("a reference committed after marking removes the orphan candidate", async () => {
  const payload = await upload();
  await sweep(base + GRACE + 1);
  await retainInput(payload.blobUri!, "late-reference", base + GRACE + 2);
  expect(await sweep(base + GRACE * 2 + 2)).toMatchObject({ artifactsDeleted: 0 });
  expect(await runtime.bucket.get(payload.blobUri!.slice(5))).not.toBeNull();
  expect(
    await runtime.db.prepare("SELECT COUNT(*) FROM core_artifact_candidates").first("COUNT(*)"),
  ).toBe(0);
});

test("references are checked again after the final object inspection", async () => {
  const payload = await upload();
  await sweep(base + GRACE + 1);
  let heads = 0;
  const bucket = {
    list: runtime.bucket.list.bind(runtime.bucket),
    delete: runtime.bucket.delete.bind(runtime.bucket),
    head: async (key: string) => {
      if (++heads === 2) await retainInput(payload.blobUri!, "during-head", base + GRACE * 2 + 2);
      return runtime.bucket.head(key);
    },
  };
  expect(
    await sweepOrphanArtifacts({ database: runtime.db, bucket, now: base + GRACE * 2 + 2 }),
  ).toMatchObject({ artifactsDeleted: 0 });
  expect(await runtime.bucket.get(payload.blobUri!.slice(5))).not.toBeNull();
});

test("all live payload families, raw snapshots, prepared reports and offloaded projections survive sweeping", async () => {
  const runs = createD1AnalysisRepository({
    database: runtime.db,
    bucket: runtime.bucket,
    now: () => base,
  });
  const encode = runs.payloads.encode.bind(runs.payloads);
  runs.payloads.encode = (value, kind, extra) => encode(value, kind, extra, true);
  runs.payloads.encodeProjection = async (value) => {
    const payload = await encode(value, "reports", 0, true);
    return JSON.stringify({ r2Payload: { uri: payload.blobUri, hash: payload.hash } });
  };
  const report = structuredClone(completeRunReportExample);
  report.runId = "live";
  report.replayManifest.runId = "live";
  for (const snapshot of report.snapshots) {
    const bytes = new TextEncoder().encode(snapshot.normalizedText);
    const key = `uploads/snapshots/${snapshot.id}/${sha256(bytes).slice(7)}/${crypto.randomUUID()}`;
    await runtime.bucket.put(key, bytes);
    snapshot.rawContentHash = sha256(bytes);
    snapshot.blobLocator = { status: "stored", uri: `r2://${key}` };
    await runs.putSnapshot({ scope, snapshot });
  }
  const evidence = report.snapshots.find(({ id }) => id !== report.primarySnapshotId)!;
  const graph = report.provenance[0]!;
  graph.nodes.push({
    ...graph.nodes[0]!,
    snapshotId: report.primarySnapshotId!,
    claimPresentInContent: false,
  });
  graph.edges.push({
    fromSnapshotId: evidence.id,
    toSnapshotId: report.primarySnapshotId!,
    type: "cites",
    supportingLocators: [
      {
        snapshotId: evidence.id,
        span: { start: 0, end: 1 },
        quote: evidence.normalizedText.slice(0, 1),
      },
    ],
  });
  const identity = { scope, runId: "live" };
  await runs.createRun({
    context: { ...structuredClone(runContextExample), ...scope, runId: "live" },
    payload: { input: "private input" },
  });
  const attempt = await runs.beginAttempt({
    ...identity,
    stage: "score_report",
    expectedVersion: 0,
  });
  await runs.checkpoint({ scope, ...attempt, checkpointHash: "checkpoint", payloadJson: "{}" });
  const readyKey = `uploads/snapshots/live/${"c".repeat(64)}/${crypto.randomUUID()}`;
  await runtime.bucket.put(readyKey, "prepared report bytes");
  await runs.prepareReport({
    ...identity,
    fencingToken: attempt.fencingToken,
    reportUri: `r2://${readyKey}`,
    reportHash: hashJson(report),
    status: "complete",
  });
  await runs.finalize({
    ...identity,
    fencingToken: attempt.fencingToken,
    reportHash: hashJson(report),
    report,
  });
  await seedUser(runtime.db, "response-owner");
  const response = await new D1PayloadStore(runtime.bucket).encode(
    { status: "complete" },
    "responses",
    0,
    true,
  );
  await runtime.db
    .prepare(
      "INSERT INTO analysis_idempotency_keys(user_id,endpoint,idempotency_key,request_hash,request_status,response_blob_uri,response_hash,response_status,expires_at,created_at,updated_at) VALUES('response-owner','start','key','hash','completed',?,?,200,?,?,?)",
    )
    .bind(response.blobUri, response.hash, base + GRACE * 10, base, base)
    .run();
  const live = (await runtime.bucket.list({ prefix: "uploads/" })).objects.map(({ key }) => key);
  const orphan = await upload();
  expect(await sweep(base + GRACE + 1)).toMatchObject({ artifactsMarked: 1 });
  expect(await sweep(base + GRACE * 2 + 2)).toMatchObject({ artifactsDeleted: 1 });
  for (const key of live) expect(await runtime.bucket.get(key)).not.toBeNull();
  expect(await runtime.bucket.get(orphan.blobUri!.slice(5))).toBeNull();
  expect(await runs.getLatestReport(identity)).toEqual(report);
  expect((await runs.readCheckpoint({ ...identity, stage: "score_report" }))?.payloadJson).toBe(
    "{}",
  );
});

for (const producer of ["run", "admission"] as const) {
  test(`an active ${producer} older than the grace period defers deletion`, async () => {
    await upload();
    const now = base + GRACE * 3;
    if (producer === "run") {
      await createD1AnalysisRepository({ database: runtime.db, now: () => base }).createRun({
        context: { ...structuredClone(runContextExample), ...scope, runId: "old" },
      });
    } else {
      await seedUser(runtime.db, "old-owner");
      await createD1AdmissionRepository({
        database: runtime.db,
        now: () => base,
      }).beginAnalysisAdmission({
        userId: "old-owner",
        endpoint: "start",
        idempotencyKey: "old",
        requestHash: "hash",
        ipHash: "ip",
        forceInputHash: "input",
        forceReanalysis: false,
        limits: {
          userRateLimit: 100,
          ipRateLimit: 100,
          rateWindowSeconds: 60,
          userConcurrencyLimit: 1,
          ipConcurrencyLimit: 1,
          dailyQuota: 100,
          forceReanalysisCooldownSeconds: 60,
          leaseSeconds: (GRACE * 10) / 1000,
          idempotencyTtlSeconds: 60,
        },
      });
    }
    expect(await sweep(now)).toMatchObject({ artifactSweepDeferred: 1, artifactsScanned: 0 });
  });
}

test("bounded pages eventually visit and remove orphan keys after durable cursor advances", async () => {
  for (let i = 0; i < 3; i++) await upload();
  let marked = 0;
  for (let page = 0; page < 3; page++) marked += (await sweep(base + GRACE + 1, 1)).artifactsMarked;
  expect(marked).toBe(3);
  let deleted = 0;
  for (let page = 0; page < 3; page++)
    deleted += (await sweep(base + GRACE * 2 + 2, 1)).artifactsDeleted;
  expect(deleted).toBe(3);
  expect((await runtime.bucket.list()).objects).toHaveLength(0);
});

test("failed deletion is re-observed safely without leaving a stranded candidate", async () => {
  const payload = await upload();
  await sweep(base + GRACE + 1);
  await expect(
    sweepOrphanArtifacts({
      database: runtime.db,
      bucket: {
        list: runtime.bucket.list.bind(runtime.bucket),
        head: runtime.bucket.head.bind(runtime.bucket),
        delete: async () => {
          throw new Error("R2 unavailable");
        },
      },
      now: base + GRACE * 2 + 2,
    }),
  ).rejects.toThrow("R2 unavailable");
  expect(await sweep(base + GRACE * 2 + 3)).toMatchObject({
    artifactsMarked: 1,
    artifactsDeleted: 0,
  });
  expect(await sweep(base + GRACE * 3 + 4)).toMatchObject({ artifactsDeleted: 1 });
  expect(await runtime.bucket.get(payload.blobUri!.slice(5))).toBeNull();
});

test("concurrent sweeps claim a candidate only once", async () => {
  await upload();
  await sweep(base + GRACE + 1);
  const counts = await Promise.all([sweep(base + GRACE * 2 + 2), sweep(base + GRACE * 2 + 2)]);
  expect(counts.reduce((sum, value) => sum + value.artifactsDeleted, 0)).toBe(1);
  await sweep(base + GRACE * 2 + 3);
  expect(
    await runtime.db.prepare("SELECT COUNT(*) FROM core_artifact_candidates").first("COUNT(*)"),
  ).toBe(0);
});

test("replaced object versions restart observation and unknown upload keys are never deleted", async () => {
  const payload = await upload();
  await runtime.bucket.put("uploads/unrecognized/object", "preserve");
  await sweep(base + GRACE + 1);
  await runtime.bucket.put(payload.blobUri!.slice(5), "replacement");
  expect(await sweep(base + GRACE * 2 + 2)).toMatchObject({
    artifactsMarked: 1,
    artifactsDeleted: 0,
  });
  expect(await runtime.bucket.get("uploads/unrecognized/object")).not.toBeNull();
});
