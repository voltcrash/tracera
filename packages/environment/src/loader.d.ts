import type { EnvironmentValues, TraceraConfigRole, TraceraProfile } from "./index.js";

export function loadProfileEnvironment(options: {
  rootDirectory: string;
  profile: TraceraProfile;
  role: TraceraConfigRole;
  inheritedEnv?: EnvironmentValues;
}): Record<string, string>;
export function findLegacyEnvironmentFiles(rootDirectory: string): string[];
export function rejectInheritedConfiguration(
  environment: EnvironmentValues,
  selectedProfile: TraceraProfile,
  selectedRole: TraceraConfigRole,
): void;
