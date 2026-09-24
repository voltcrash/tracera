import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vite-plus/test";
import {
  assertAnalysisStorageTestDatabase,
  assertEnvironmentConfiguration,
  createEnvironmentSeal,
  redactedEnvironmentDiagnostic,
  withTestRunDatabase,
} from "../src/index.js";
import { findLegacyEnvironmentFiles, loadProfileEnvironment } from "../src/loader.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a valid generated local runtime profile is accepted and diagnostics are redacted", () => {
  const environment = localRuntimeEnvironment({ NODE_ENV: "production" });
  const result = assertEnvironmentConfiguration(environment, "runtime");
  const diagnostic = redactedEnvironmentDiagnostic(environment);

  assert.deepEqual(result, { profile: "local", role: "runtime" });
  assert.match(diagnostic, /profile=local role=runtime/);
  assert.match(diagnostic, /tracera_runtime@\[127\.0\.0\.1\]:25432\/tracera_worktree_dev/);
  assert.doesNotMatch(diagnostic, /database-password|auth-secret/);
});

test("a selected profile cannot be modified after the launcher seals it", () => {
  const environment = localRuntimeEnvironment();
  environment.DATABASE_URL =
    "postgresql://tracera_runtime:database-password@production.example/tracera_worktree_dev";

  assert.throws(
    () => assertEnvironmentConfiguration(environment, "runtime"),
    /environment seal is missing or invalid/,
  );
});

test("local profiles reject remote database targets before they can be used", () => {
  const environment = localRuntimeEnvironment({
    DATABASE_URL:
      "postgresql://tracera_runtime:database-password@production.example/tracera_worktree_dev",
  });

  assert.throws(
    () => assertEnvironmentConfiguration(environment, "runtime"),
    /must use a loopback host/,
  );
});

test("roles cannot receive another role's database credentials", () => {
  const environment = localRuntimeEnvironment({
    DATABASE_MIGRATOR_URL:
      "postgresql://tracera_migrator:password@127.0.0.1:25432/tracera_worktree_dev",
  });

  assert.throws(
    () => assertEnvironmentConfiguration(environment, "runtime"),
    /runtime configuration cannot contain DATABASE_MIGRATOR_URL/,
  );
});

test("database role names must match the selected process role", () => {
  const environment = localRuntimeEnvironment({
    DATABASE_URL:
      "postgresql://tracera_migrator:database-password@127.0.0.1:25432/tracera_worktree_dev",
  });

  assert.throws(
    () => assertEnvironmentConfiguration(environment, "runtime"),
    /must use the tracera_runtime role/,
  );
});

test("profile and role mismatches fail closed", () => {
  const environment = localRuntimeEnvironment({ TRACERA_CONFIG_ROLE: "migration" });

  assert.throws(
    () => assertEnvironmentConfiguration(environment, "runtime"),
    /Configuration role mismatch/,
  );
});

test("local and test profiles reject external provider credentials and endpoints", () => {
  const environment = localRuntimeEnvironment({
    AI_API_KEY: "must-not-be-used",
    AI_BASE_URL: "https://paid-provider.example/v1",
  });

  assert.throws(
    () => assertEnvironmentConfiguration(environment, "runtime"),
    /forbids external provider credentials and endpoints: AI_API_KEY, AI_BASE_URL/,
  );
});

test("local analysis is fixture-only and deployed profiles cannot activate fixtures", () => {
  assert.throws(
    () =>
      assertEnvironmentConfiguration(
        localRuntimeEnvironment({ TRACERA_ANALYSIS_MODE: "live" }),
        "runtime",
      ),
    /requires TRACERA_ANALYSIS_MODE=fixture/,
  );
  assert.throws(
    () =>
      assertEnvironmentConfiguration(
        {
          TRACERA_PROFILE: "deployed",
          TRACERA_CONFIG_ROLE: "runtime",
          TRACERA_ANALYSIS_MODE: "fixture",
          DATABASE_URL: "postgresql://tracera_runtime:password@database.example/tracera",
          BETTER_AUTH_SECRET: "auth-secret-at-least-32-characters",
        },
        "runtime",
      ),
    /deployed profile cannot use deterministic analysis fixtures/,
  );
  assert.throws(
    () =>
      assertEnvironmentConfiguration(
        {
          TRACERA_PROFILE: "deployed",
          TRACERA_CONFIG_ROLE: "runtime",
          AI_PROVIDER: "fixture",
          AI_API_KEY: "not-a-real-key",
          DATABASE_URL: "postgresql://tracera_runtime:password@database.example/tracera",
          BETTER_AUTH_SECRET: "auth-secret-at-least-32-characters",
        },
        "runtime",
      ),
    /deployed profile cannot use deterministic analysis fixtures/,
  );
});

test("local application origins must be loopback-only and match their generated port", () => {
  assert.throws(
    () =>
      assertEnvironmentConfiguration(
        localRuntimeEnvironment({ TRACERA_APP_ORIGIN: "https://production.example" }),
        "runtime",
      ),
    /application origins must be loopback-only/,
  );
  assert.throws(
    () =>
      assertEnvironmentConfiguration(
        localRuntimeEnvironment({ TRACERA_APP_ORIGIN: "http://localhost:3000" }),
        "runtime",
      ),
    /matching TRACERA_APP_PORT/,
  );
});

test("the profile loader rejects inherited credentials without exposing their values", () => {
  const rootDirectory = profileDirectory();
  const inheritedSecret = "production-secret-must-not-appear";

  assert.throws(
    () =>
      loadProfileEnvironment({
        rootDirectory,
        profile: "local",
        role: "runtime",
        inheritedEnv: { AI_API_KEY: inheritedSecret },
      }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /AI_API_KEY/);
      assert.doesNotMatch(error.message, new RegExp(inheritedSecret));
      return true;
    },
  );
});

test("legacy root files and conflicting selected files fail instead of overriding", () => {
  const legacyRoot = profileDirectory();
  writeFileSync(join(legacyRoot, ".env"), "DATABASE_URL=postgresql://do-not-read\n");
  assert.throws(
    () =>
      loadProfileEnvironment({
        rootDirectory: legacyRoot,
        profile: "local",
        role: "runtime",
      }),
    /Legacy root environment file detected/,
  );

  const conflictRoot = profileDirectory();
  writeFileSync(
    join(conflictRoot, ".tracera/environment/local/runtime.env"),
    "TRACERA_DATABASE_PORT=9999\nDATABASE_URL=postgresql://tracera_runtime:password@127.0.0.1:25432/tracera_worktree_dev\nBETTER_AUTH_SECRET=auth-secret-at-least-32-characters\n",
  );
  assert.throws(
    () =>
      loadProfileEnvironment({
        rootDirectory: conflictRoot,
        profile: "local",
        role: "runtime",
      }),
    /Conflicting setting TRACERA_DATABASE_PORT/,
  );
});

test("setup and loading detect every Next.js environment file variant", () => {
  const root = profileDirectory();
  mkdirSync(join(root, "apps/web"), { recursive: true });
  writeFileSync(join(root, ".env.example"), "");
  writeFileSync(join(root, ".env.development.local"), "");
  writeFileSync(join(root, "apps/web/.env.production.local"), "");

  assert.deepEqual(findLegacyEnvironmentFiles(root), [
    ".env.development.local",
    "apps/web/.env.production.local",
  ]);
});

test("core storage integration targets must be disposable loopback test databases", () => {
  const target = (url: string, profile = "test") =>
    localRuntimeEnvironment({ TRACERA_PROFILE: profile, ANALYSIS_STORAGE_TEST_DATABASE_URL: url });
  const disposable =
    "postgresql://tracera_runtime:password@127.0.0.1:25432/tracera_worktree_dev_run1";

  assert.equal(assertAnalysisStorageTestDatabase(target(disposable)), disposable);
  assert.throws(
    () =>
      assertAnalysisStorageTestDatabase(
        target(
          "postgresql://tracera_runtime:password@production.example/tracera_worktree_dev_run1",
        ),
      ),
    /must use a loopback host/,
  );
  assert.throws(
    () =>
      assertAnalysisStorageTestDatabase(
        target("postgresql://tracera_runtime:password@127.0.0.1:25432/tracera_worktree_dev"),
      ),
    /does not match this worktree's provisioned database/,
  );
  assert.throws(
    () => assertAnalysisStorageTestDatabase(target(disposable, "local")),
    /runtime configuration cannot contain ANALYSIS_STORAGE_TEST_DATABASE_URL/,
  );
  assert.throws(
    () => assertAnalysisStorageTestDatabase({ ANALYSIS_STORAGE_TEST_DATABASE_URL: disposable }),
    /TRACERA_PROFILE/,
  );
});

test("test runtime and migration roles can target only this worktree's run databases", () => {
  const testRuntime = localRuntimeEnvironment({ TRACERA_PROFILE: "test" });
  const runtime = withTestRunDatabase(testRuntime, "a1b2c3");
  assert.match(runtime.DATABASE_URL ?? "", /@127\.0\.0\.1:25432\/tracera_worktree_dev_a1b2c3$/);
  assert.deepEqual(assertEnvironmentConfiguration(runtime, "runtime"), {
    profile: "test",
    role: "runtime",
  });

  const migration: Record<string, string | undefined> = {
    TRACERA_PROFILE: "test",
    TRACERA_CONFIG_ROLE: "migration",
    TRACERA_CONFIG_SOURCE: "generated-worktree",
    TRACERA_WORKTREE_ID: "worktree",
    TRACERA_DATABASE_HOST: "127.0.0.1",
    TRACERA_DATABASE_PORT: "25432",
    TRACERA_DATABASE_NAME: "tracera_worktree_dev",
    DATABASE_MIGRATOR_URL:
      "postgresql://tracera_migrator:password@127.0.0.1:25432/tracera_worktree_dev",
  };
  migration.TRACERA_CONFIG_SEAL = createEnvironmentSeal(migration);
  assert.match(
    withTestRunDatabase(migration, "run2").DATABASE_MIGRATOR_URL ?? "",
    /\/tracera_worktree_dev_run2$/,
  );

  for (const runId of ["", "Run1", "run-1", "run_1", "x".repeat(17), "../postgres"]) {
    assert.throws(() => withTestRunDatabase(testRuntime, runId), /Test run IDs/);
  }
  assert.throws(
    () => withTestRunDatabase(localRuntimeEnvironment(), "run1"),
    /only to test-profile runtime and migration roles/,
  );
  assert.throws(
    () =>
      assertEnvironmentConfiguration(
        localRuntimeEnvironment({
          DATABASE_URL:
            "postgresql://tracera_runtime:password@127.0.0.1:25432/tracera_worktree_dev_run1",
        }),
        "runtime",
      ),
    /does not match this worktree's provisioned database/,
  );
  assert.throws(
    () =>
      assertEnvironmentConfiguration(
        localRuntimeEnvironment({
          TRACERA_PROFILE: "test",
          DATABASE_URL:
            "postgresql://tracera_runtime:password@127.0.0.1:25432/tracera_worktree_dev_other-db",
        }),
        "runtime",
      ),
    /does not match this worktree's provisioned database/,
  );
});

test("deployed runtime accepts only its own database role and rejects migrator credentials", () => {
  const deployed = {
    TRACERA_PROFILE: "deployed",
    TRACERA_CONFIG_ROLE: "runtime",
    DATABASE_URL: "postgresql://tracera_runtime:password@database.example/tracera",
    BETTER_AUTH_SECRET: "auth-secret-at-least-32-characters",
  };

  assert.deepEqual(assertEnvironmentConfiguration(deployed, "runtime"), {
    profile: "deployed",
    role: "runtime",
  });
  assert.throws(
    () =>
      assertEnvironmentConfiguration(
        {
          ...deployed,
          DATABASE_MIGRATOR_URL: "postgresql://owner:password@database.example/tracera",
        },
        "runtime",
      ),
    /runtime configuration cannot contain DATABASE_MIGRATOR_URL/,
  );
  assert.throws(
    () =>
      loadProfileEnvironment({
        rootDirectory: profileDirectory(),
        profile: "deployed",
        role: "runtime",
      }),
    /must come from the deployment environment/,
  );
});

function localRuntimeEnvironment(overrides: Record<string, string> = {}) {
  const environment: Record<string, string> = {
    TRACERA_PROFILE: "local",
    TRACERA_CONFIG_ROLE: "runtime",
    TRACERA_CONFIG_SOURCE: "generated-worktree",
    TRACERA_WORKTREE_ID: "worktree",
    TRACERA_DATABASE_HOST: "127.0.0.1",
    TRACERA_DATABASE_PORT: "25432",
    TRACERA_DATABASE_NAME: "tracera_worktree_dev",
    TRACERA_APP_ORIGIN: "http://localhost:4173",
    TRACERA_APP_PORT: "4173",
    TRACERA_ANALYSIS_MODE: "fixture",
    DATABASE_URL:
      "postgresql://tracera_runtime:database-password@127.0.0.1:25432/tracera_worktree_dev",
    BETTER_AUTH_SECRET: "auth-secret-at-least-32-characters",
    ...overrides,
  };
  environment.TRACERA_CONFIG_SEAL = createEnvironmentSeal(environment);
  return environment;
}

function profileDirectory() {
  const root = mkdtempSync(join(tmpdir(), "tracera-environment-test-"));
  temporaryDirectories.push(root);
  const directory = join(root, ".tracera/environment/local");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "shared.env"),
    "TRACERA_WORKTREE_ID=worktree\nTRACERA_DATABASE_HOST=127.0.0.1\nTRACERA_DATABASE_PORT=25432\nTRACERA_DATABASE_NAME=tracera_worktree_dev\n",
  );
  writeFileSync(
    join(directory, "runtime.env"),
    "DATABASE_URL=postgresql://tracera_runtime:password@127.0.0.1:25432/tracera_worktree_dev\nBETTER_AUTH_SECRET=auth-secret-at-least-32-characters\nTRACERA_APP_ORIGIN=http://localhost:4173\nTRACERA_APP_PORT=4173\nTRACERA_ANALYSIS_MODE=fixture\n",
  );
  return root;
}
