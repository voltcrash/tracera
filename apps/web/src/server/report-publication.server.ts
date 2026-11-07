import { createR2RawBlobStore } from "@repo/ai/analysis/ingestion";
import { hashValue } from "@repo/ai/analysis";
import { runReportSchema } from "@repo/contracts/analysis";
import type { AnalysisAccessScope } from "@repo/db";
import type { analysisStorage } from "./analysis-api.server";
import type { ServerEnv } from "./env";

export async function publishPreparedReport(
  env: ServerEnv,
  storage: ReturnType<typeof analysisStorage>,
  identity: { scope: AnalysisAccessScope; runId: string },
) {
  const prepared = await storage.runs.getPreparedReport(identity);
  if (!prepared) return null;
  const blobs = createR2RawBlobStore(
    env.BLOBS as unknown as Parameters<typeof createR2RawBlobStore>[0],
  );
  const bytes = await blobs.read(prepared.reportUri, new AbortController().signal);
  if (!bytes) throw new Error("The prepared analysis report is unavailable.");
  const report = runReportSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  if (hashValue(report) !== prepared.reportHash || report.status !== prepared.status)
    throw new Error("The prepared analysis report failed integrity validation.");
  await storage.runs.finalize({
    ...identity,
    fencingToken: prepared.fencingToken,
    reportHash: prepared.reportHash,
    report,
  });
  return report.status;
}
