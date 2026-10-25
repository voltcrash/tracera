import { readFile } from "node:fs/promises";
import {
  completeRunReportExample,
  noClaimRunReportExample,
  runContextExample,
  unavailableRunReportExample,
} from "@repo/contracts/analysis";
import { expect, test } from "vite-plus/test";
import { createD1AnalysisRepository } from "../../src/repository.js";
import { createTestRuntime } from "./runtime.js";

test("history migration backfills inline reports and preserves legacy R2 reports", async () => {
  const runtime = await createTestRuntime();
  try {
    const repository = createD1AnalysisRepository({ database: runtime.db, bucket: runtime.bucket });
    const examples = [
      completeRunReportExample,
      noClaimRunReportExample,
      completeRunReportExample,
      unavailableRunReportExample,
    ];
    for (const [index, example] of examples.entries()) {
      const runId = `migration-${index}`;
      const scope = { tenantId: "migration", ownerUserId: runId, visibility: "private" as const };
      const context = { ...structuredClone(runContextExample), ...scope, runId };
      const report = { ...structuredClone(example), runId };
      report.replayManifest.runId = runId;
      if (index === 2) report.snapshots[0]!.normalizedText += "測".repeat(600_000);
      await repository.createRun({ context });
      for (const snapshot of report.snapshots) await repository.putSnapshot({ scope, snapshot });
      const attempt = await repository.beginAttempt({
        scope,
        runId,
        stage: "score_report",
        expectedVersion: 0,
      });
      await repository.finalize({ scope, ...attempt, reportHash: context.inputHash, report });
    }
    const before = await runtime.db
      .prepare(
        "SELECT run_id,report_hash,report,report_blob_uri FROM core_report_versions ORDER BY run_id",
      )
      .all();
    await runtime.db.prepare("ALTER TABLE core_report_versions DROP COLUMN summary_headline").run();
    const migration = await readFile(
      new URL("../../migrations/0003_organic_sway.sql", import.meta.url),
      "utf8",
    );
    await runtime.db.batch(
      migration
        .split("--> statement-breakpoint")
        .filter((sql) => sql.trim())
        .map((sql) => runtime.db.prepare(sql)),
    );
    const after = await runtime.db
      .prepare(
        "SELECT run_id,report_hash,report,report_blob_uri FROM core_report_versions ORDER BY run_id",
      )
      .all();
    expect(after.results).toEqual(before.results);
    const headlines = await runtime.db
      .prepare("SELECT summary_headline FROM core_report_versions ORDER BY run_id")
      .all<{ summary_headline: string | null }>();
    expect(headlines.results.map(({ summary_headline }) => summary_headline)).toEqual([
      completeRunReportExample.claims[0]!.text,
      noClaimRunReportExample.claims[0]!.text,
      null,
      "Focused analysis",
    ]);
    for (const index of [0, 1, 2, 3]) {
      const ownerUserId = `migration-${index}`;
      const reader =
        index === 2 ? repository : createD1AnalysisRepository({ database: runtime.db });
      const summaries = await reader.listRunSummaries({
        scope: { tenantId: "migration", ownerUserId, visibility: "private" },
        limit: 30,
      });
      expect(summaries[0]!.headline).toBe(
        index === 1
          ? noClaimRunReportExample.claims[0]!.text
          : index === 3
            ? "Focused analysis"
            : completeRunReportExample.claims[0]!.text,
      );
    }
  } finally {
    await runtime.dispose();
  }
});
