import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

export const ARTIFACT_GRACE_MS = 24 * 60 * 60 * 1000;
const managedKey =
  /^uploads\/(?:payloads\/(?:run-inputs|checkpoints|snapshots|reports|responses)|snapshots\/[a-zA-Z0-9_-]+)\/[a-f0-9]{64}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const references = [
  ["core_runs", "input_blob_uri,json_extract(prepared_report,'$.reportUri')"],
  ["core_stage_checkpoints", "payload_blob_uri"],
  ["core_snapshots", "snapshot_blob_uri,blob_uri"],
  ["core_report_versions", "report_blob_uri"],
  ["analysis_idempotency_keys", "response_blob_uri"],
  ["core_report_claims", "json_extract(claim,'$.r2Payload.uri')"],
  ["core_evidence_assessments", "json_extract(assessment,'$.r2Payload.uri')"],
  ["core_provenance_edges", "json_extract(edge,'$.r2Payload.uri')"],
  ["core_decisions", "json_extract(decision,'$.r2Payload.uri')"],
] as const;

async function referencedUris(database: D1Database, uris: string[]) {
  if (uris.length === 0) return new Set<string>();
  const result = await database.batch<{ uri: string }>(
    references.map(([table, values]) =>
      database
        .prepare(`SELECT DISTINCT value AS uri FROM ${table},json_each(json_array(${values}))
      WHERE value IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(uris)),
    ),
  );
  return new Set(result.flatMap(({ results }) => results.map(({ uri }) => uri)));
}

export async function sweepOrphanArtifacts(input: {
  database: D1Database;
  bucket: Pick<R2Bucket, "list" | "head" | "delete">;
  now: number;
  pageSize?: number;
}) {
  const { database, bucket, now } = input;
  const limit = input.pageSize ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new RangeError("Artifact sweep page size must be between 1 and 1000.");
  const counts = {
    artifactsScanned: 0,
    artifactsMarked: 0,
    artifactsDeleted: 0,
    artifactSweepDeferred: 0,
  };
  const cutoff = now - ARTIFACT_GRACE_MS;
  const oldWriter = await database
    .prepare(`SELECT 1 AS present WHERE
    EXISTS(SELECT 1 FROM core_runs WHERE finalized_at IS NULL AND created_at<=?) OR
    EXISTS(SELECT 1 FROM analysis_leases WHERE released_at IS NULL AND created_at<=? AND (run_id IS NOT NULL OR expires_at>?))`)
    .bind(cutoff, cutoff, now)
    .first();
  if (oldWriter) return { ...counts, artifactSweepDeferred: 1 };
  const prior = await database
    .prepare("SELECT uri FROM core_artifact_candidates ORDER BY first_seen_at,uri LIMIT ?")
    .bind(limit)
    .all<{ uri: string }>();
  for (const { uri } of prior.results) {
    if (!(await bucket.head(uri.slice("r2://".length))))
      await database.prepare("DELETE FROM core_artifact_candidates WHERE uri=?").bind(uri).run();
  }
  const cursor = await database
    .prepare("SELECT last_key FROM core_artifact_sweep_state WHERE id='blobs'")
    .first<string | null>("last_key");
  const page = await bucket.list({
    prefix: "uploads/",
    limit,
    ...(cursor ? { startAfter: cursor } : {}),
  });
  const uris = page.objects
    .filter(({ key }) => managedKey.test(key))
    .map(({ key }) => `r2://${key}`);
  const retained = await referencedUris(database, uris);
  for (const object of page.objects) {
    counts.artifactsScanned++;
    if (!managedKey.test(object.key)) continue;
    const uri = `r2://${object.key}`;
    if (retained.has(uri) || object.uploaded.getTime() > cutoff) {
      await database.prepare("DELETE FROM core_artifact_candidates WHERE uri=?").bind(uri).run();
      continue;
    }
    const candidate = await database
      .prepare("SELECT object_version,first_seen_at FROM core_artifact_candidates WHERE uri=?")
      .bind(uri)
      .first<{ object_version: string; first_seen_at: number }>();
    if (!candidate || candidate.object_version !== object.version) {
      await database
        .prepare(`INSERT INTO core_artifact_candidates(uri,object_version,first_seen_at) VALUES(?,?,?)
        ON CONFLICT(uri) DO UPDATE SET object_version=excluded.object_version,first_seen_at=excluded.first_seen_at`)
        .bind(uri, object.version, now)
        .run();
      counts.artifactsMarked++;
      continue;
    }
    if (candidate.first_seen_at > cutoff) continue;
    const current = await bucket.head(object.key);
    if (!current || current.version !== object.version || current.uploaded.getTime() > cutoff) {
      await database.prepare("DELETE FROM core_artifact_candidates WHERE uri=?").bind(uri).run();
      continue;
    }
    if ((await referencedUris(database, [uri])).has(uri)) {
      await database.prepare("DELETE FROM core_artifact_candidates WHERE uri=?").bind(uri).run();
      continue;
    }
    const claimed = await database
      .prepare(
        "DELETE FROM core_artifact_candidates WHERE uri=? AND object_version=? AND first_seen_at=? RETURNING uri",
      )
      .bind(uri, candidate.object_version, candidate.first_seen_at)
      .all();
    if (!claimed.results.length) continue;
    // Upload keys are never reused; old producers defer the sweep before listing.
    await bucket.delete(object.key);
    counts.artifactsDeleted++;
  }
  await database
    .prepare(`INSERT INTO core_artifact_sweep_state(id,last_key) VALUES('blobs',?)
    ON CONFLICT(id) DO UPDATE SET last_key=excluded.last_key`)
    .bind(page.truncated ? page.objects.at(-1)!.key : null)
    .run();
  return counts;
}
