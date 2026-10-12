import {
  completeRunReportExample,
  runContextExample,
  type RunReport,
} from "@repo/contracts/analysis";
import { hashValue } from "@repo/ai/analysis/hashing";
import { executeLocalSql, sqlValue } from "./d1";

function insert(table: string, values: Record<string, unknown>) {
  return `INSERT INTO ${table}(${Object.keys(values).join(",")}) VALUES(${Object.values(values).map(sqlValue).join(",")});`;
}

export function seedBrowserRun(ownerUserId: string, status: "queued" | "failed" | "complete") {
  const runId = `browser-${crypto.randomUUID()}`;
  const scope = {
    tenant_id: `user:${ownerUserId}`,
    owner_user_id: ownerUserId,
    visibility: "private",
  };
  const context = {
    ...structuredClone(runContextExample),
    runId,
    tenantId: scope.tenant_id,
    ownerUserId,
    visibility: "private" as const,
  };
  const report: RunReport | null =
    status === "complete" ? structuredClone(completeRunReportExample) : null;
  if (report) {
    report.runId = runId;
    report.replayManifest.runId = runId;
  }
  const now = Date.now();
  const statements = [
    insert("core_runs", {
      run_id: runId,
      ...scope,
      input_hash: context.inputHash,
      context_hash: hashValue(context),
      as_of_time: Date.parse(context.asOfTime),
      execution_mode: "fixture",
      status,
      stage: status === "complete" ? "score_report" : "normalize_input",
      versions: JSON.stringify(context.versions),
      budget: JSON.stringify(context.budget),
      cancellation: JSON.stringify(context.cancellation),
      audit_sink_id: context.auditSinkId,
      created_at: now,
      updated_at: now,
      finalized_at: status === "queued" ? null : now,
      last_error: status === "failed" ? "synthetic-provider-canary" : null,
    }),
  ];
  if (report) {
    for (const snapshot of report.snapshots)
      statements.push(
        insert("core_snapshots", {
          snapshot_id: snapshot.id,
          ...scope,
          content_hash: snapshot.contentHash,
          raw_content_hash: snapshot.rawContentHash,
          normalized_text: snapshot.normalizedText,
          snapshot: JSON.stringify(snapshot),
          snapshot_hash: hashValue(snapshot),
          blob_status: snapshot.blobLocator.status,
          blob_uri: snapshot.blobLocator.uri,
          created_at: Date.parse(snapshot.acquiredAt),
        }),
      );
    statements.push(
      insert("core_report_versions", {
        run_id: runId,
        version: 1,
        ...scope,
        report_hash: hashValue(report),
        schema_version: report.schemaVersion,
        contract_version: report.contractVersion,
        engine_version: report.engineVersion,
        diagnostic_labels: JSON.stringify(
          report.decisions.map(({ diagnosticLabel }) => diagnosticLabel),
        ),
        published_labels: JSON.stringify(
          report.decisions.map(({ publishedLabel }) => publishedLabel),
        ),
        factual_score: report.scorecard?.factualScore ?? null,
        score_null_reasons: JSON.stringify(report.scorecard?.nullReasons ?? []),
        evidence_set_hash: report.evidenceSetHash,
        report: JSON.stringify(report),
        created_at: now,
      }),
    );
    for (const snapshot of report.snapshots)
      statements.push(
        insert("core_report_snapshots", {
          run_id: runId,
          report_version: 1,
          ...scope,
          snapshot_id: snapshot.id,
        }),
      );
  }
  executeLocalSql(statements.join("\n"));
  return { runId, report };
}
