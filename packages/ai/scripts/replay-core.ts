import { readFile } from "node:fs/promises";
import { createCalibrateDecisionsV2 } from "../src/core/calibration/index.js";
import { replayAnalysisV2, type CorePorts, type RunEnvironment } from "../src/core/index.js";
import { runContextSchema, runReportSchema } from "@repo/contracts/core-v2";

const reportPath = requiredArgument("--report");
const tenantId = requiredArgument("--tenant-id");
const ownerUserId = requiredArgument("--owner-user-id");
const artifactPath = optionalArgument("--calibrator");
const report = runReportSchema.parse(JSON.parse(await readFile(reportPath, "utf8")));
const artifact = artifactPath ? JSON.parse(await readFile(artifactPath, "utf8")) : null;
const snapshots = new Map(report.snapshots.map((snapshot) => [snapshot.id, snapshot]));
const context = runContextSchema.parse({
  runId: report.runId,
  tenantId,
  ownerUserId,
  visibility: report.visibility,
  inputHash: report.replayManifest.inputHash,
  asOfTime: report.asOfTime,
  versions: report.replayManifest.versions,
  executionMode: "replay",
  budget: report.replayManifest.budget,
  cancellation: { requested: false, requestedAt: null, reason: null },
  auditSinkId: `replay:${report.runId}`,
});
const clock = { now: () => report.createdAt, monotonicMs: () => 0 };
const unavailable = async () => {
  throw new Error("Model and acquisition ports are unavailable during deterministic replay.");
};
const ports: CorePorts = {
  generation: {
    modelId: context.versions.model,
    promptVersion: context.versions.prompt,
    generate: unavailable,
  },
  embeddings: {
    modelId: context.versions.embedding.model,
    dimensions: context.versions.embedding.dimensions,
    preprocessing: context.versions.embedding.preprocessing,
    embed: unavailable,
  },
  search: [],
  documents: { acquire: unavailable, acquireFromText: unavailable },
  snapshots: {
    put: unavailable,
    get: async (id) => snapshots.get(id) ?? null,
    getMany: async (ids) => ids.flatMap((id) => (snapshots.has(id) ? [snapshots.get(id)!] : [])),
  },
  runs: { checkpoint: unavailable, readCheckpoint: unavailable, finalize: unavailable },
  clock,
  audit: { sinkId: context.auditSinkId, record: async () => undefined },
};
const environment: RunEnvironment = { context, ports, signal: new AbortController().signal };
const replayed = await replayAnalysisV2({
  report,
  environment,
  calibrateDecisions: createCalibrateDecisionsV2({ artifact }),
});
console.log(JSON.stringify(replayed, null, 2));

function requiredArgument(name: string) {
  const value = optionalArgument(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optionalArgument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
