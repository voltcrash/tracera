import { afterEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { OpenAiCompatibleProvider, InstrumentedAiProvider } from "../src/index";
import { createAnalysisGenerationPort, createProviderOcrPort } from "../src/analysis/runtime-ports";
import { createDocumentAcquisitionPort } from "../src/analysis/ingestion/index";
import { GenerationUsageError } from "../src/analysis/generation-usage";
import { createAssessEvidence } from "../src/analysis/evidence/index";
import {
  assessmentResponse,
  createScriptedEvidenceEnvironment,
  evidenceClaim,
  evidenceSnapshot,
} from "../scripts/support/scripted-evidence";
import type { GenerationRequest } from "../src/analysis/types";

afterEach(() => vi.unstubAllGlobals());

function generation() {
  return createAnalysisGenerationPort({
    provider: new OpenAiCompatibleProvider({
      apiKey: "fixture",
      baseUrl: "https://provider.example/v1",
    }),
    modelId: "fixture",
    promptVersion: "fixture",
    estimatedGenerationCostUsd: 0.01,
  });
}
const request = () => ({
  schemaName: "fixture",
  schema: z.object({ answer: z.string() }),
  system: "fixture",
  prompt: "fixture",
  untrustedContent: [],
  images: [],
  maxOutputTokens: null,
  signal: new AbortController().signal,
});

test("generation charges both physical requests in a successful repair", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls += 1;
    return Response.json({
      choices: [{ message: { content: calls === 1 ? "invalid" : '{"answer":"ok"}' } }],
    });
  });
  const result = await generation().generate(request());
  expect(calls).toBe(2);
  expect(result.attempts).toBe(2);
  expect(result.usage.costUsd).toBe(0.02);
});

test("a repair followed by an HTTP failure retains its two request charges", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls += 1;
    return calls === 1
      ? Response.json({ choices: [{ message: { content: "invalid" } }] })
      : new Response(null, { status: 503 });
  });
  const error = await generation()
    .generate(request())
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(GenerationUsageError);
  expect(error).toMatchObject({ attempts: 2, usage: { costUsd: 0.02 } });
  expect(calls).toBe(2);
});

test("a denied physical request never reaches transport or consumes generation usage", async () => {
  const transport = vi.fn();
  vi.stubGlobal("fetch", transport);
  const port = createAnalysisGenerationPort({
    provider: new InstrumentedAiProvider(
      new OpenAiCompatibleProvider({ apiKey: "fixture", baseUrl: "https://provider.example/v1" }),
      {
        onCall: async (_call, operation) => operation(),
        onRequest: () => {
          throw new Error("Run allowance exhausted.");
        },
      },
    ),
    modelId: "fixture",
    promptVersion: "fixture",
    estimatedGenerationCostUsd: 0.01,
  });
  const error = await port.generate(request()).catch((error: unknown) => error);
  expect(error).toMatchObject({ attempts: 0, usage: { costUsd: 0 } });
  expect(transport).not.toHaveBeenCalled();
});

test("assessment consumes repair attempts before admitting another passage", async () => {
  const claim = evidenceClaim();
  const snapshots = [
    evidenceSnapshot("first", claim.text),
    evidenceSnapshot("second", `${claim.text} More detail.`),
  ];
  const scripted = createScriptedEvidenceEnvironment(({ claim, snapshotId, passage }) =>
    assessmentResponse(claim, snapshotId, passage),
  );
  const generate = scripted.environment.ports.generation.generate.bind(
    scripted.environment.ports.generation,
  );
  scripted.environment.ports.generation.generate = async <Value>(
    input: GenerationRequest<Value>,
  ) => ({ ...(await generate(input)), attempts: 2 });
  const result = await createAssessEvidence({ maxGenerationRequests: 2 })(
    { claims: [claim], snapshots, admittedSnapshotIds: snapshots.map(({ id }) => id) },
    scripted.environment,
  );
  expect(scripted.calls).toBe(1);
  expect(result.metrics.externalRequests).toBe(2);
  expect(result.issues.some(({ code }) => code === "budget_exhausted")).toBe(true);
});

test("OCR repair requests retain image cost estimates in acquisition metrics", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls += 1;
    return Response.json({
      choices: [{ message: { content: calls === 1 ? "invalid" : '{"regions":[]}' } }],
    });
  });
  const provider = new OpenAiCompatibleProvider({
    apiKey: "fixture",
    baseUrl: "https://provider.example/v1",
  });
  const documents = createDocumentAcquisitionPort({
    now: () => new Date().toISOString(),
    ocr: createProviderOcrPort({ provider, modelId: "fixture" }),
    ocrCostUsd: 0.02,
  });
  const result = await documents.acquireImage({
    data: "data:image/png;base64,iVBORw0KGgo=",
    mimeType: "image/png",
    caption: null,
    role: "submitted_input",
    maxBytes: 1000,
    signal: new AbortController().signal,
  });
  expect(calls).toBe(2);
  expect(result.metrics.externalRequests).toBe(2);
  expect(result.metrics.costUsd).toBe(0.04);
});
