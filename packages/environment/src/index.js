import { createHash } from "node:crypto";

export const TRACERA_PROFILES = ["local", "test", "deployed"];
export const TRACERA_CONFIG_ROLES = ["runtime", "migration", "test-provisioning", "analysis"];

export const TRACERA_CONTROL_KEYS = [
  "TRACERA_PROFILE",
  "TRACERA_CONFIG_ROLE",
  "TRACERA_CONFIG_SOURCE",
  "TRACERA_CONFIG_SEAL",
];
const CONTROL_KEYS = new Set(TRACERA_CONTROL_KEYS);

export const MANAGED_ENVIRONMENT_KEYS = [
  "DATABASE_URL",
  "DATABASE_MIGRATOR_URL",
  "TEST_DATABASE_PROVISIONER_URL",
  "CORE_STORAGE_TEST_DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "DEV_AUTH_BYPASS",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "AI_PROVIDER",
  "AI_API_KEY",
  "AI_MODEL",
  "AI_EMBEDDING_MODEL",
  "AI_BASE_URL",
  "AI_EMBEDDING_PROVIDER",
  "AI_EMBEDDING_API_KEY",
  "AI_EMBEDDING_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_FACT_CHECK_API_KEY",
  "NEWS_API_KEY",
  "JINA_API_KEY",
  "ANALYSIS_USER_RATE_LIMIT",
  "ANALYSIS_IP_RATE_LIMIT",
  "ANALYSIS_RATE_WINDOW_SECONDS",
  "ANALYSIS_USER_CONCURRENCY_LIMIT",
  "ANALYSIS_IP_CONCURRENCY_LIMIT",
  "ANALYSIS_DAILY_QUOTA",
  "ANALYSIS_FORCE_REANALYSIS_COOLDOWN_SECONDS",
  "ANALYSIS_LEASE_SECONDS",
  "ANALYSIS_IDEMPOTENCY_TTL_SECONDS",
  "AI_DAILY_SPEND_LIMIT_USD",
  "AI_ESTIMATED_GENERATION_COST_USD",
  "AI_ESTIMATED_IMAGE_COST_USD",
  "AI_ESTIMATED_EMBEDDING_COST_USD",
  "CORE_V2_MAX_EXTERNAL_REQUESTS",
  "CORE_V2_MAX_DISCOVERY_QUERIES_PER_CLAIM",
  "CORE_V2_MAX_FETCHED_CANDIDATES_PER_CLAIM",
  "CORE_V2_MAX_PROVENANCE_HOPS",
  "CORE_V2_MAX_TARGETED_RETRIEVAL_ROUNDS",
  "CORE_V2_MAX_ELAPSED_MS",
  "CORE_V2_MAX_CONCURRENT_EXTERNAL_CALLS",
  "CORE_V2_MAX_COST_USD",
  "DOMAIN_TRUST_AUTO_REFINE",
  "DOMAIN_TRUST_ADMIN_TOKEN",
  "TRACERA_WORKTREE_ID",
  "TRACERA_DATABASE_HOST",
  "TRACERA_DATABASE_PORT",
  "TRACERA_DATABASE_NAME",
  "TRACERA_APP_ORIGIN",
  "TRACERA_APP_PORT",
  "TRACERA_ANALYSIS_MODE",
];

const MANAGED_KEYS = new Set(MANAGED_ENVIRONMENT_KEYS);
const EXTERNAL_PROVIDER_KEYS = new Set([
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_EMBEDDING_API_KEY",
  "AI_EMBEDDING_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_FACT_CHECK_API_KEY",
  "NEWS_API_KEY",
  "JINA_API_KEY",
]);
const TEST_RUN_ID_PATTERN = /^[a-z0-9]{1,16}$/;
const DATABASE_KEYS = new Set([
  "DATABASE_URL",
  "DATABASE_MIGRATOR_URL",
  "TEST_DATABASE_PROVISIONER_URL",
  "CORE_STORAGE_TEST_DATABASE_URL",
]);

export class EnvironmentConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnvironmentConfigurationError";
  }
}

export function assertEnvironmentConfiguration(environment, expectedRole) {
  const profile = environment.TRACERA_PROFILE;
  const role = environment.TRACERA_CONFIG_ROLE;
  assertProfile(profile);
  assertRole(role);
  if (role !== expectedRole) {
    throw new EnvironmentConfigurationError(
      `Configuration role mismatch: expected ${expectedRole}, received ${role}.`,
    );
  }

  if (profile === "local" || profile === "test") {
    if (environment.TRACERA_CONFIG_SOURCE !== "generated-worktree") {
      throw new EnvironmentConfigurationError(
        `${profile} configuration must be loaded from generated worktree files.`,
      );
    }
    assertEnvironmentSeal(environment);
    rejectExternalProviders(environment, profile);
    if (
      (role === "runtime" || role === "analysis") &&
      environment.TRACERA_ANALYSIS_MODE !== "fixture"
    ) {
      throw new EnvironmentConfigurationError(
        `${profile} profile requires TRACERA_ANALYSIS_MODE=fixture.`,
      );
    }
  } else if (
    environment.TRACERA_ANALYSIS_MODE === "fixture" ||
    environment.AI_PROVIDER === "fixture"
  ) {
    throw new EnvironmentConfigurationError(
      "The deployed profile cannot use deterministic analysis fixtures.",
    );
  }

  assertRoleSeparation(environment, role);
  if (role === "runtime") {
    requireSetting(environment, "DATABASE_URL");
    requireSetting(environment, "BETTER_AUTH_SECRET");
    assertDatabaseUrl(environment.DATABASE_URL, environment, role);
    if (profile === "local" || profile === "test") assertApplicationOrigin(environment);
  } else if (role === "migration") {
    requireSetting(environment, "DATABASE_MIGRATOR_URL");
    assertDatabaseUrl(environment.DATABASE_MIGRATOR_URL, environment, role);
  } else if (role === "test-provisioning") {
    if (profile === "deployed") {
      throw new EnvironmentConfigurationError(
        "Test provisioning cannot run with the deployed profile.",
      );
    }
    requireSetting(environment, "TEST_DATABASE_PROVISIONER_URL");
    assertDatabaseUrl(environment.TEST_DATABASE_PROVISIONER_URL, environment, role);
  }

  return { profile, role };
}

function assertApplicationOrigin(environment) {
  requireSetting(environment, "TRACERA_APP_ORIGIN");
  requireSetting(environment, "TRACERA_APP_PORT");
  let origin;
  try {
    origin = new URL(environment.TRACERA_APP_ORIGIN);
  } catch {
    throw new EnvironmentConfigurationError("TRACERA_APP_ORIGIN must be a valid URL.");
  }
  if (
    origin.protocol !== "http:" ||
    !isLoopbackHostname(origin.hostname) ||
    origin.port !== environment.TRACERA_APP_PORT ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new EnvironmentConfigurationError(
      "Local and test application origins must be loopback-only HTTP URLs matching TRACERA_APP_PORT.",
    );
  }
}

export function assertCoreStorageTestDatabase(environment) {
  const { profile } = assertEnvironmentConfiguration(environment, "runtime");
  if (profile !== "test") {
    throw new EnvironmentConfigurationError(
      "CORE_STORAGE_TEST_DATABASE_URL can only be used with the test profile.",
    );
  }
  requireSetting(environment, "CORE_STORAGE_TEST_DATABASE_URL");
  assertDatabaseUrl(
    environment.CORE_STORAGE_TEST_DATABASE_URL,
    environment,
    "runtime",
    "CORE_STORAGE_TEST_DATABASE_URL",
  );
  return environment.CORE_STORAGE_TEST_DATABASE_URL;
}

/**
 * Retargets a sealed test-profile runtime or migration environment at one
 * disposable run database (`<TRACERA_DATABASE_NAME>_<runId>`) and reseals it.
 */
export function withTestRunDatabase(environment, runId) {
  const { profile, role } = assertEnvironmentConfiguration(
    environment,
    environment.TRACERA_CONFIG_ROLE,
  );
  if (profile !== "test" || (role !== "runtime" && role !== "migration")) {
    throw new EnvironmentConfigurationError(
      "Run databases are available only to test-profile runtime and migration roles.",
    );
  }
  if (!TEST_RUN_ID_PATTERN.test(runId)) {
    throw new EnvironmentConfigurationError(
      "Test run IDs must be 1-16 lowercase letters or digits.",
    );
  }
  const key = databaseKeyForRole(role);
  const url = new URL(environment[key]);
  url.pathname = `/${environment.TRACERA_DATABASE_NAME}_${runId}`;
  const derived = { ...environment, [key]: url.toString() };
  derived.TRACERA_CONFIG_SEAL = createEnvironmentSeal(derived);
  assertEnvironmentConfiguration(derived, role);
  return derived;
}

export function assertEnvironmentIfConfigured(environment, expectedRole) {
  const configured =
    Boolean(environment.TRACERA_PROFILE) ||
    MANAGED_ENVIRONMENT_KEYS.some((key) => Boolean(environment[key]));
  if (!configured) return null;
  return assertEnvironmentConfiguration(environment, expectedRole);
}

export function createEnvironmentSeal(environment) {
  const entries = Object.entries(environment)
    .filter(
      ([key, value]) =>
        key !== "TRACERA_CONFIG_SEAL" &&
        value !== undefined &&
        (MANAGED_KEYS.has(key) || CONTROL_KEYS.has(key)),
    )
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function redactedEnvironmentDiagnostic(environment) {
  const { profile, role } = assertEnvironmentConfiguration(
    environment,
    environment.TRACERA_CONFIG_ROLE,
  );
  const databaseUrl = databaseUrlForRole(environment, role);
  const target = databaseUrl ? redactDatabaseUrl(databaseUrl) : "none";
  return `Tracera environment: profile=${profile} role=${role} target=${target}`;
}

function assertProfile(profile) {
  if (!TRACERA_PROFILES.includes(profile)) {
    throw new EnvironmentConfigurationError(
      `TRACERA_PROFILE must be one of: ${TRACERA_PROFILES.join(", ")}.`,
    );
  }
}

function assertRole(role) {
  if (!TRACERA_CONFIG_ROLES.includes(role)) {
    throw new EnvironmentConfigurationError(
      `TRACERA_CONFIG_ROLE must be one of: ${TRACERA_CONFIG_ROLES.join(", ")}.`,
    );
  }
}

function assertEnvironmentSeal(environment) {
  const seal = environment.TRACERA_CONFIG_SEAL;
  if (!seal || seal !== createEnvironmentSeal(environment)) {
    throw new EnvironmentConfigurationError(
      "Generated environment seal is missing or invalid; a file or process modified the selected configuration.",
    );
  }
}

function rejectExternalProviders(environment, profile) {
  const configured = [...EXTERNAL_PROVIDER_KEYS].filter((key) => Boolean(environment[key]));
  if (configured.length > 0) {
    throw new EnvironmentConfigurationError(
      `${profile} profile forbids external provider credentials and endpoints: ${configured.sort().join(", ")}.`,
    );
  }
}

function assertRoleSeparation(environment, role) {
  const allowedDatabaseKeys = {
    runtime:
      environment.TRACERA_PROFILE === "test"
        ? ["DATABASE_URL", "CORE_STORAGE_TEST_DATABASE_URL"]
        : ["DATABASE_URL"],
    migration: ["DATABASE_MIGRATOR_URL"],
    "test-provisioning": ["TEST_DATABASE_PROVISIONER_URL"],
    analysis: [],
  }[role];
  const forbidden = [...DATABASE_KEYS].filter(
    (key) => !allowedDatabaseKeys.includes(key) && Boolean(environment[key]),
  );
  if (forbidden.length > 0) {
    throw new EnvironmentConfigurationError(
      `${role} configuration cannot contain ${forbidden.sort().join(", ")}.`,
    );
  }
  const runtimeOnly = [
    "BETTER_AUTH_SECRET",
    "DEV_AUTH_BYPASS",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "ANALYSIS_USER_RATE_LIMIT",
    "ANALYSIS_IP_RATE_LIMIT",
    "ANALYSIS_RATE_WINDOW_SECONDS",
    "ANALYSIS_USER_CONCURRENCY_LIMIT",
    "ANALYSIS_IP_CONCURRENCY_LIMIT",
    "ANALYSIS_DAILY_QUOTA",
    "ANALYSIS_FORCE_REANALYSIS_COOLDOWN_SECONDS",
    "ANALYSIS_LEASE_SECONDS",
    "ANALYSIS_IDEMPOTENCY_TTL_SECONDS",
    "AI_DAILY_SPEND_LIMIT_USD",
    "AI_ESTIMATED_GENERATION_COST_USD",
    "AI_ESTIMATED_IMAGE_COST_USD",
    "AI_ESTIMATED_EMBEDDING_COST_USD",
    "CORE_V2_MAX_EXTERNAL_REQUESTS",
    "CORE_V2_MAX_DISCOVERY_QUERIES_PER_CLAIM",
    "CORE_V2_MAX_FETCHED_CANDIDATES_PER_CLAIM",
    "CORE_V2_MAX_PROVENANCE_HOPS",
    "CORE_V2_MAX_TARGETED_RETRIEVAL_ROUNDS",
    "CORE_V2_MAX_ELAPSED_MS",
    "CORE_V2_MAX_CONCURRENT_EXTERNAL_CALLS",
    "CORE_V2_MAX_COST_USD",
    "DOMAIN_TRUST_AUTO_REFINE",
    "DOMAIN_TRUST_ADMIN_TOKEN",
    "TRACERA_APP_ORIGIN",
    "TRACERA_APP_PORT",
  ];
  const analysisSettings = [
    "TRACERA_ANALYSIS_MODE",
    "AI_PROVIDER",
    "AI_API_KEY",
    "AI_MODEL",
    "AI_EMBEDDING_MODEL",
    "AI_BASE_URL",
    "AI_EMBEDDING_PROVIDER",
    "AI_EMBEDDING_API_KEY",
    "AI_EMBEDDING_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_FACT_CHECK_API_KEY",
    "NEWS_API_KEY",
    "JINA_API_KEY",
  ];
  const disallowed = [
    ...(role === "runtime" ? [] : runtimeOnly),
    ...(role === "runtime" || role === "analysis" ? [] : analysisSettings),
  ].filter((key) => Boolean(environment[key]));
  if (disallowed.length > 0) {
    throw new EnvironmentConfigurationError(
      `${role} configuration contains settings for another process: ${disallowed.sort().join(", ")}.`,
    );
  }
}

function requireSetting(environment, key) {
  if (!environment[key]) throw new EnvironmentConfigurationError(`${key} is required.`);
}

function assertDatabaseUrl(value, environment, role, key = databaseKeyForRole(role)) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new EnvironmentConfigurationError(`${key} must be a PostgreSQL URL.`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new EnvironmentConfigurationError(`${key} must use PostgreSQL.`);
  }

  const expectedUser =
    environment.TRACERA_PROFILE === "deployed"
      ? { runtime: "tracera_runtime" }[role]
      : {
          runtime: "tracera_runtime",
          migration: "tracera_migrator",
          "test-provisioning": "tracera_test_provisioner",
        }[role];
  if (expectedUser && decodeURIComponent(url.username) !== expectedUser) {
    throw new EnvironmentConfigurationError(`${key} must use the ${expectedUser} role.`);
  }

  if (environment.TRACERA_PROFILE === "deployed") {
    if (role === "migration" && decodeURIComponent(url.username) === "tracera_runtime") {
      throw new EnvironmentConfigurationError(
        "DATABASE_MIGRATOR_URL cannot use the runtime database role.",
      );
    }
    return;
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new EnvironmentConfigurationError(
      `${environment.TRACERA_PROFILE} profile database targets must use a loopback host.`,
    );
  }
  requireSetting(environment, "TRACERA_WORKTREE_ID");
  requireSetting(environment, "TRACERA_DATABASE_HOST");
  requireSetting(environment, "TRACERA_DATABASE_PORT");
  requireSetting(environment, "TRACERA_DATABASE_NAME");
  if (!isLoopbackHostname(environment.TRACERA_DATABASE_HOST)) {
    throw new EnvironmentConfigurationError("TRACERA_DATABASE_HOST must be loopback-only.");
  }
  if (
    url.hostname !== environment.TRACERA_DATABASE_HOST ||
    url.port !== environment.TRACERA_DATABASE_PORT
  ) {
    throw new EnvironmentConfigurationError(
      `${key} does not match this worktree's provisioned host and port.`,
    );
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  const expectedDatabase =
    role === "test-provisioning" ? "postgres" : environment.TRACERA_DATABASE_NAME;
  // Integration runs use disposable databases named after the worktree test database.
  const isRunDatabase =
    databaseName.startsWith(`${expectedDatabase}_`) &&
    TEST_RUN_ID_PATTERN.test(databaseName.slice(expectedDatabase.length + 1));
  const matchesDatabase =
    key === "CORE_STORAGE_TEST_DATABASE_URL"
      ? isRunDatabase
      : databaseName === expectedDatabase ||
        (environment.TRACERA_PROFILE === "test" && role !== "test-provisioning" && isRunDatabase);
  if (!matchesDatabase) {
    throw new EnvironmentConfigurationError(
      `${key} does not match this worktree's provisioned database.`,
    );
  }
}

function databaseUrlForRole(environment, role) {
  const key = {
    runtime: "DATABASE_URL",
    migration: "DATABASE_MIGRATOR_URL",
    "test-provisioning": "TEST_DATABASE_PROVISIONER_URL",
    analysis: null,
  }[role];
  return key ? environment[key] : undefined;
}

function databaseKeyForRole(role) {
  return {
    runtime: "DATABASE_URL",
    migration: "DATABASE_MIGRATOR_URL",
    "test-provisioning": "TEST_DATABASE_PROVISIONER_URL",
  }[role];
}

function redactDatabaseUrl(value) {
  const url = new URL(value);
  const port = url.port ? `:${url.port}` : "";
  return `${url.protocol}//${decodeURIComponent(url.username)}@[${url.hostname}]${port}${url.pathname}`;
}

function isLoopbackHostname(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}
