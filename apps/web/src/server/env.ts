import { env as workerEnv } from "cloudflare:workers";
import { z } from "zod";

const optional = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional(),
);

function binding<T>(name: string, method: string) {
  return z.custom<T>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as Record<string, unknown>)[method] === "function",
    `${name} binding is missing.`,
  );
}

const limits = [
  "ANALYSIS_USER_RATE_LIMIT",
  "ANALYSIS_IP_RATE_LIMIT",
  "ANALYSIS_RATE_WINDOW_SECONDS",
  "ANALYSIS_USER_CONCURRENCY_LIMIT",
  "ANALYSIS_IP_CONCURRENCY_LIMIT",
  "ANALYSIS_DAILY_QUOTA",
  "ANALYSIS_IDEMPOTENCY_TTL_SECONDS",
  "ANALYSIS_FORCE_REANALYSIS_COOLDOWN_SECONDS",
  "ANALYSIS_LEASE_SECONDS",
  "ANALYSIS_MAX_ELAPSED_MS",
  "ANALYSIS_MAX_COST_USD",
  "ANALYSIS_MAX_EXTERNAL_REQUESTS",
  "ANALYSIS_MAX_CONCURRENT_EXTERNAL_CALLS",
  "ANALYSIS_MAX_DISCOVERY_QUERIES_PER_CLAIM",
  "ANALYSIS_MAX_FETCHED_CANDIDATES_PER_CLAIM",
  "ANALYSIS_MAX_TARGETED_RETRIEVAL_ROUNDS",
  "ANALYSIS_MAX_PROVENANCE_HOPS",
  "AI_DAILY_SPEND_LIMIT_USD",
  "AI_ESTIMATED_GENERATION_COST_USD",
  "AI_ESTIMATED_EMBEDDING_COST_USD",
  "AI_ESTIMATED_IMAGE_COST_USD",
] as const;
const limitShape = Object.fromEntries(limits.map((name) => [name, optional])) as Record<
  (typeof limits)[number],
  typeof optional
>;

const serverEnvSchema = z
  .object({
    DB: binding<D1Database>("DB", "prepare"),
    BLOBS: binding<R2Bucket>("BLOBS", "put"),
    ANALYSIS_WORKFLOW: binding<Workflow>("ANALYSIS_WORKFLOW", "create"),
    MODE: z.enum(["dev", "production"]),
    ANALYSIS_MODE: z.enum(["fixture", "live"]),
    VERSION: optional.transform((value) => value ?? "unknown"),
    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET needs at least 32 characters."),
    BETTER_AUTH_URL: optional,
    DEV_AUTH_BYPASS: z.enum(["true", "false"]).optional(),
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    GITHUB_CLIENT_ID: optional,
    GITHUB_CLIENT_SECRET: optional,
    AI_PROVIDER: optional,
    AI_MODEL: optional,
    AI_API_KEY: optional,
    AI_BASE_URL: optional,
    AI_EMBEDDING_PROVIDER: optional,
    AI_EMBEDDING_MODEL: optional,
    AI_EMBEDDING_API_KEY: optional,
    AI_EMBEDDING_BASE_URL: optional,
    GOOGLE_FACT_CHECK_API_KEY: optional,
    NEWS_API_KEY: optional,
    ...limitShape,
  })
  .superRefine((value, context) => {
    if (value.MODE !== "production") return;
    if (value.ANALYSIS_MODE !== "live")
      context.addIssue({
        code: "custom",
        path: ["ANALYSIS_MODE"],
        message: "Production requires live analysis.",
      });
    if (value.DEV_AUTH_BYPASS === "true")
      context.addIssue({
        code: "custom",
        path: ["DEV_AUTH_BYPASS"],
        message: "Production cannot enable the dev sign-in bypass.",
      });
    if (!isHttpsOrigin(value.BETTER_AUTH_URL))
      context.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_URL"],
        message: "Production requires BETTER_AUTH_URL to be one HTTPS origin.",
      });
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class ServerEnvError extends Error {
  override name = "ServerEnvError";
}

/** Issues name the setting and rule only, so secret values never reach logs. */
export function parseServerEnv(input: unknown): ServerEnv {
  const result = serverEnvSchema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  throw new ServerEnvError(`Invalid Worker configuration. ${issues.join(" ")}`);
}

export function serverEnv(): ServerEnv {
  // `vp run dev:live` serves in Vite's `live` mode, because .dev.vars wins over any config var.
  const liveDevelopment = import.meta.env.DEV && import.meta.env.MODE === "live";
  return parseServerEnv(liveDevelopment ? { ...workerEnv, ANALYSIS_MODE: "live" } : workerEnv);
}

function isHttpsOrigin(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.href === `${url.origin}/`;
  } catch {
    return false;
  }
}
