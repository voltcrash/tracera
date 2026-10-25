import { resolveAnalysisProvider, validateProviderKeyEncryptionConfiguration } from "@repo/ai";
import { z } from "zod";
import { analysisPolicy } from "../src/server/analysis-policy";

type Values = Record<string, string | undefined>;

const LOCAL_AUTH_SECRET = "tracera-local-development-secret-only";
const REQUIRED_SECRETS = [
  "BETTER_AUTH_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
];
const PROVIDER_SETTINGS = [
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_EMBEDDING_PROVIDER",
  "AI_EMBEDDING_MODEL",
  "AI_EMBEDDING_API_KEY",
  "AI_EMBEDDING_BASE_URL",
];

const resources = z.object({
  name: z.string(),
  d1_databases: z
    .array(z.object({ binding: z.literal("DB"), database_name: z.string(), database_id: z.uuid() }))
    .length(1),
  r2_buckets: z.array(z.object({ binding: z.literal("BLOBS"), bucket_name: z.string() })).length(1),
  workflows: z
    .array(
      z.object({
        binding: z.literal("ANALYSIS_WORKFLOW"),
        name: z.string(),
        class_name: z.literal("AnalysisWorkflow"),
      }),
    )
    .length(1),
});
const productionConfig = resources.extend({
  name: z.literal("tracera"),
  workers_dev: z.literal(false),
  preview_urls: z.literal(false),
  routes: z.array(z.object({ pattern: z.string(), custom_domain: z.literal(true) })).length(1),
  vars: z
    .object({
      MODE: z.literal("production"),
      ANALYSIS_MODE: z.literal("live"),
      BETTER_AUTH_URL: z.url(),
      VERSION: z.string(),
    })
    .catchall(z.string()),
  secrets: z.object({ required: z.array(z.string()) }),
  triggers: z.object({ crons: z.array(z.string()).min(1) }),
});

function configured(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "" && !/^(replace-|your-)/i.test(value.trim());
}

function encryptionKeys(secret: string) {
  const ring = JSON.parse(secret) as { keys: Record<string, string> };
  return Object.values(ring.keys).map((value) => btoa(atob(value)));
}

function resourceIds(config: z.infer<typeof resources>) {
  return [
    config.name,
    config.d1_databases[0]!.database_name,
    config.d1_databases[0]!.database_id,
    config.r2_buckets[0]!.bucket_name,
    config.workflows[0]!.name,
  ];
}

/**
 * Port of oxytype's production-inputs checks. Messages name settings only, never
 * their values, because CI prints them.
 */
export function validateProductionInputs(inputs: {
  config: unknown;
  stagingConfig: unknown;
  secrets: Values;
  stagingSecrets?: Values;
  built?: unknown;
}) {
  const parsed = productionConfig.safeParse(inputs.config);
  if (!parsed.success)
    throw new Error("wrangler.production.json must describe the isolated production Worker.");
  const config = parsed.data;
  const staging = resources.safeParse(inputs.stagingConfig);
  if (!staging.success) throw new Error("wrangler.jsonc must describe the staging Worker.");
  const stagingIds = new Set(resourceIds(staging.data));
  if (resourceIds(config).some((id) => stagingIds.has(id)))
    throw new Error(
      "Production Worker, D1, R2 and Workflow names and IDs must differ from staging.",
    );

  const origin = new URL(config.vars.BETTER_AUTH_URL);
  if (
    origin.protocol !== "https:" ||
    origin.href !== `${origin.origin}/` ||
    config.routes[0]!.pattern !== origin.hostname
  )
    throw new Error("Production BETTER_AUTH_URL and the custom domain must be one HTTPS origin.");
  for (const name of REQUIRED_SECRETS)
    if (!config.secrets.required.includes(name))
      throw new Error(`wrangler.production.json must require the ${name} secret.`);

  const settings: Values = { ...config.vars, ...inputs.secrets };
  if (settings.MODE !== "production") throw new Error("Production requires MODE=production.");
  if (settings.ANALYSIS_MODE !== "live")
    throw new Error("Production requires ANALYSIS_MODE=live; fixture analysis is local only.");
  if ("VERSION" in inputs.secrets)
    throw new Error("Remove VERSION from .dev.vars.production; the build assigns its identity.");
  if ("DEV_AUTH_BYPASS" in inputs.secrets)
    throw new Error("Remove DEV_AUTH_BYPASS from .dev.vars.production.");

  for (const [name, value] of Object.entries(inputs.secrets))
    if (value?.trim() && !configured(value))
      throw new Error(`Replace the placeholder ${name} in .dev.vars.production.`);
  for (const name of [...REQUIRED_SECRETS, ...config.secrets.required]) {
    const value = inputs.secrets[name];
    if (!configured(value)) throw new Error(`Configure ${name} in .dev.vars.production.`);
    if (value === inputs.stagingSecrets?.[name])
      throw new Error(`${name} must be separate from staging.`);
  }
  const authSecret = inputs.secrets.BETTER_AUTH_SECRET!;
  if (authSecret.length < 32 || authSecret === LOCAL_AUTH_SECRET)
    throw new Error("Use a new production BETTER_AUTH_SECRET with at least 32 characters.");

  // D18: without any provider settings, production runs with analysis unavailable.
  const platform = PROVIDER_SETTINGS.some((name) => configured(settings[name]));
  if (platform) {
    try {
      resolveAnalysisProvider({ userId: "production-check", env: settings });
    } catch (error) {
      throw new Error(
        `Production AI provider configuration is incomplete: ${(error as Error).message}`,
      );
    }

    const runtime = analysisPolicy(
      { ...settings, MODE: "production", ANALYSIS_MODE: "live" },
      "production-check",
    );
    if (!runtime.enabled)
      throw new Error(`Production analysis controls are incomplete: ${runtime.message}`);
  }

  const personal = configured(inputs.secrets.PROVIDER_KEYS_ENCRYPTION_KEY);
  if (configured(config.vars.PROVIDER_KEYS_ENCRYPTION_KEY))
    throw new Error("PROVIDER_KEYS_ENCRYPTION_KEY must be a Worker secret, not a Wrangler var.");
  if (personal) {
    try {
      validateProviderKeyEncryptionConfiguration(inputs.secrets.PROVIDER_KEYS_ENCRYPTION_KEY);
    } catch {
      throw new Error(
        "Configure a valid versioned PROVIDER_KEYS_ENCRYPTION_KEY in .dev.vars.production.",
      );
    }
    const stagingEncryption = inputs.stagingSecrets?.PROVIDER_KEYS_ENCRYPTION_KEY;
    if (configured(stagingEncryption)) {
      try {
        validateProviderKeyEncryptionConfiguration(stagingEncryption);
      } catch {
        throw new Error(
          "Configure a valid staging PROVIDER_KEYS_ENCRYPTION_KEY before comparing environments.",
        );
      }
      const productionMaterial = new Set(
        encryptionKeys(inputs.secrets.PROVIDER_KEYS_ENCRYPTION_KEY!),
      );
      if (encryptionKeys(stagingEncryption).some((key) => productionMaterial.has(key)))
        throw new Error("PROVIDER_KEYS_ENCRYPTION_KEY must be separate from staging.");
    }
    const runtime = analysisPolicy(
      { ...settings, MODE: "production", ANALYSIS_MODE: "live" },
      "personal-production-check",
      {
        source: "user",
        config: {
          provider: "openai",
          model: "personal-model",
          embeddingModel: "personal-embedding",
        },
      },
    );
    if (!runtime.enabled)
      throw new Error(`Production BYOK controls are incomplete: ${runtime.message}`);
  }

  if (inputs.built !== undefined) {
    const built = resources.safeParse(inputs.built);
    if (
      !built.success ||
      resourceIds(built.data).join() !== resourceIds(config).join() ||
      (inputs.built as { vars?: Values }).vars?.MODE !== "production"
    )
      throw new Error("Rebuild with build:production; dist/server is not the production Worker.");
  }
  return { analysis: platform || personal };
}
