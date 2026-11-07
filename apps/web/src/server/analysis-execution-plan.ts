import { z } from "zod";
import { providerBaseUrl, type ModelProviderConfig, type ResolvedAnalysisProvider } from "@repo/ai";
import { hashValue } from "@repo/ai/analysis/hashing";
import { runContextSchema, type RunContext } from "@repo/contracts/analysis";
import { analysisRuntimeVersions } from "./analysis-runtime-versions";

export class ExecutionPlanUnavailableError extends Error {
  constructor() {
    super("This run's execution plan is unavailable. Start a new analysis.");
    this.name = "ExecutionPlanUnavailableError";
  }
}

const baseUrl = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !value.includes("?") &&
      !value.includes("#")
    );
  } catch {
    return false;
  }
});
const model = z.strictObject({
  provider: z.enum(["anthropic", "gemini", "openai", "openrouter", "openai-compatible"]),
  model: z.string().min(1),
  baseUrl,
});
const provider = z
  .strictObject({
    source: z.enum(["platform", "user"]),
    revisionId: z.string().min(1).optional(),
    generation: model,
    embedding: model.extend({
      provider: z.enum(["gemini", "openai", "openrouter", "openai-compatible"]),
      dimensions: z.literal(1024),
      keySource: z.enum(["generation", "embedding"]),
    }),
  })
  .superRefine((value, ctx) => {
    if ((value.source === "user") !== Boolean(value.revisionId))
      ctx.addIssue({
        code: "custom",
        message: "Provider credential identity is required.",
        path: ["revisionId"],
      });
    if (
      value.embedding.keySource === "generation" &&
      (value.embedding.provider !== value.generation.provider ||
        value.embedding.baseUrl !== value.generation.baseUrl)
    )
      ctx.addIssue({
        code: "custom",
        message: "Shared credentials require the same route.",
        path: ["embedding"],
      });
  });
const estimates = z.strictObject({
  generationCostUsd: z.number().finite().positive(),
  imageCostUsd: z.number().finite().positive(),
  embeddingCostUsd: z.number().finite().positive(),
});
const discovery = z.strictObject({ googleFactCheck: z.boolean(), newsApi: z.boolean() });
const fixture = z.strictObject({
  version: z.literal(1),
  mode: z.literal("fixture"),
  versions: runContextSchema.shape.versions,
});
const live = z.strictObject({
  version: z.literal(1),
  mode: z.literal("live"),
  versions: runContextSchema.shape.versions,
  provider,
  estimates,
  discovery,
});
const schema = z.discriminatedUnion("mode", [fixture, live]);
export type ExecutionPlan = z.infer<typeof schema>;
export type LiveExecutionPlan = z.infer<typeof live>;

function modelPlan(config: ModelProviderConfig) {
  try {
    return {
      provider: config.provider,
      model: config.model,
      baseUrl: new URL(providerBaseUrl(config)).href,
    };
  } catch {
    throw new ExecutionPlanUnavailableError();
  }
}

export function providerPlan(resolved: ResolvedAnalysisProvider): LiveExecutionPlan["provider"] {
  const config = resolved.config;
  const parsed = provider.safeParse({
    source: resolved.source,
    ...(resolved.revisionId ? { revisionId: resolved.revisionId } : {}),
    generation: modelPlan(config),
    embedding: {
      ...modelPlan(config.embedding ?? { ...config, model: config.embeddingModel }),
      dimensions: config.embedding?.dimensions ?? config.embeddingDimensions ?? 1024,
      keySource: config.embedding ? "embedding" : "generation",
    },
  });
  if (!parsed.success) throw new ExecutionPlanUnavailableError();
  return parsed.data;
}

export function createLiveExecutionPlan(input: {
  resolved: ResolvedAnalysisProvider;
  versions: RunContext["versions"];
  estimates: LiveExecutionPlan["estimates"];
  discovery: LiveExecutionPlan["discovery"];
}): LiveExecutionPlan {
  const parsed = live.safeParse({
    version: 1,
    mode: "live",
    provider: providerPlan(input.resolved),
    versions: input.versions,
    estimates: input.estimates,
    discovery: input.discovery,
  });
  if (!parsed.success) throw new ExecutionPlanUnavailableError();
  return parsed.data;
}

export function createFixtureExecutionPlan(versions: RunContext["versions"]): ExecutionPlan {
  return { version: 1, mode: "fixture", versions };
}

export function assertExecutionPlanContext(plan: ExecutionPlan, context: RunContext) {
  const supported = analysisRuntimeVersions(
    plan.mode,
    context.versions.model,
    context.versions.embedding.model,
  );
  if (
    plan.mode !== context.executionMode ||
    hashValue(plan.versions) !== hashValue(context.versions) ||
    hashValue(plan.versions) !== hashValue(supported)
  )
    throw new ExecutionPlanUnavailableError();
  if (plan.mode === "live") {
    if (
      plan.provider.source !== context.provider?.source ||
      plan.provider.generation.provider !== context.provider.provider ||
      plan.provider.revisionId !== context.provider.revisionId ||
      plan.provider.generation.model !== context.versions.model ||
      plan.provider.embedding.model !== context.versions.embedding.model
    )
      throw new ExecutionPlanUnavailableError();
    for (const target of [plan.provider.generation, plan.provider.embedding])
      if (target.provider === "gemini" && target.baseUrl !== providerBaseUrl(target))
        throw new ExecutionPlanUnavailableError();
  }
}

export function readExecutionPlan(context: RunContext, payload: unknown): ExecutionPlan {
  const raw =
    payload && typeof payload === "object" && "executionPlan" in payload
      ? payload.executionPlan
      : undefined;
  const parsed = schema.safeParse(
    raw === undefined
      ? context.executionMode === "fixture"
        ? createFixtureExecutionPlan(context.versions)
        : null
      : raw,
  );
  if (!parsed.success) throw new ExecutionPlanUnavailableError();
  assertExecutionPlanContext(parsed.data, context);
  return parsed.data;
}
