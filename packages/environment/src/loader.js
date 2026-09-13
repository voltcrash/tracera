import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import {
  assertEnvironmentConfiguration,
  createEnvironmentSeal,
  EnvironmentConfigurationError,
  MANAGED_ENVIRONMENT_KEYS,
  TRACERA_CONFIG_ROLES,
  TRACERA_CONTROL_KEYS,
  TRACERA_PROFILES,
} from "./index.js";

const CONTROL_KEYS = new Set(TRACERA_CONTROL_KEYS);
const MANAGED_KEYS = new Set(MANAGED_ENVIRONMENT_KEYS);
// Next.js loads .env, .env.local, and .env.<mode>[.local] from its app directory.
const LEGACY_ENV_DIRECTORIES = [".", "apps/web", "packages/ai", "packages/auth", "packages/db"];

export function loadProfileEnvironment({ rootDirectory, profile, role, inheritedEnv = {} }) {
  if (!TRACERA_PROFILES.includes(profile)) {
    throw new EnvironmentConfigurationError(
      `TRACERA_PROFILE must be one of: ${TRACERA_PROFILES.join(", ")}.`,
    );
  }
  if (!TRACERA_CONFIG_ROLES.includes(role)) {
    throw new EnvironmentConfigurationError(
      `TRACERA_CONFIG_ROLE must be one of: ${TRACERA_CONFIG_ROLES.join(", ")}.`,
    );
  }
  if (profile === "deployed") {
    throw new EnvironmentConfigurationError(
      "Deployed configuration must come from the deployment environment, not local files.",
    );
  }

  rejectLegacyFiles(rootDirectory);
  rejectInheritedConfiguration(inheritedEnv, profile, role);

  const profileDirectory = `${rootDirectory}/.tracera/environment/${profile}`;
  const paths = [`${profileDirectory}/shared.env`, `${profileDirectory}/${role}.env`];
  const values = {};
  const owners = new Map();

  for (const path of paths) {
    if (!existsSync(path)) {
      throw new EnvironmentConfigurationError(
        `Missing generated ${profile}/${role} configuration. Run "vp run env:setup" first.`,
      );
    }
    const parsed = parseEnv(readFileSync(path, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (CONTROL_KEYS.has(key)) {
        throw new EnvironmentConfigurationError(
          `${key} is launcher-controlled and cannot appear in ${path}.`,
        );
      }
      if (!MANAGED_KEYS.has(key)) {
        throw new EnvironmentConfigurationError(`Unknown managed setting ${key} in ${path}.`);
      }
      const previousOwner = owners.get(key);
      if (previousOwner) {
        throw new EnvironmentConfigurationError(
          `Conflicting setting ${key} appears in both ${previousOwner} and ${path}.`,
        );
      }
      owners.set(key, path);
      values[key] = value;
    }
  }

  const selected = {
    ...values,
    TRACERA_PROFILE: profile,
    TRACERA_CONFIG_ROLE: role,
    TRACERA_CONFIG_SOURCE: "generated-worktree",
  };
  selected.TRACERA_CONFIG_SEAL = createEnvironmentSeal(selected);
  assertEnvironmentConfiguration(selected, role);
  return selected;
}

export function rejectInheritedConfiguration(environment, selectedProfile, selectedRole) {
  const inherited = [...MANAGED_ENVIRONMENT_KEYS, ...TRACERA_CONTROL_KEYS].filter((key) =>
    Boolean(environment[key]),
  );
  if (inherited.length === 0) return;
  throw new EnvironmentConfigurationError(
    `Refusing inherited Tracera configuration for ${selectedProfile}/${selectedRole}: ${inherited.sort().join(", ")}. Unset these variables before using the profile launcher.`,
  );
}

export function findLegacyEnvironmentFiles(rootDirectory) {
  return LEGACY_ENV_DIRECTORIES.flatMap((directory) => {
    const path = `${rootDirectory}/${directory}`;
    if (!existsSync(path)) return [];
    return readdirSync(path)
      .filter((name) => (name === ".env" || name.startsWith(".env.")) && name !== ".env.example")
      .map((name) => (directory === "." ? name : `${directory}/${name}`));
  }).sort();
}

function rejectLegacyFiles(rootDirectory) {
  const found = findLegacyEnvironmentFiles(rootDirectory);
  if (found.length > 0) {
    throw new EnvironmentConfigurationError(
      `Legacy root environment file detected (${found.join(", ")}). Move it outside the repository before using generated profiles; do not copy its values into local configuration.`,
    );
  }
}
