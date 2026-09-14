export const TRACERA_PROFILES: readonly ["local", "test", "deployed"];
export const TRACERA_CONFIG_ROLES: readonly [
  "runtime",
  "migration",
  "test-provisioning",
  "analysis",
];
export const MANAGED_ENVIRONMENT_KEYS: readonly string[];
export const TRACERA_CONTROL_KEYS: readonly string[];

export type TraceraProfile = (typeof TRACERA_PROFILES)[number];
export type TraceraConfigRole = (typeof TRACERA_CONFIG_ROLES)[number];
export type EnvironmentValues = Record<string, string | undefined>;

export class EnvironmentConfigurationError extends Error {}

export function assertEnvironmentConfiguration(
  environment: EnvironmentValues,
  expectedRole: TraceraConfigRole,
): { profile: TraceraProfile; role: TraceraConfigRole };
export function assertCoreStorageTestDatabase(environment: EnvironmentValues): string;
export function withTestRunDatabase(
  environment: EnvironmentValues,
  runId: string,
): EnvironmentValues;
export function assertEnvironmentIfConfigured(
  environment: EnvironmentValues,
  expectedRole: TraceraConfigRole,
): { profile: TraceraProfile; role: TraceraConfigRole } | null;
export function createEnvironmentSeal(environment: EnvironmentValues): string;
export function redactedEnvironmentDiagnostic(environment: EnvironmentValues): string;
