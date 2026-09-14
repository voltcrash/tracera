import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  createAuth,
  DEV_AUTH_BYPASS_PATH,
  devAuthBypassEnabled,
  localAuthIdentities,
} from "@repo/auth";
import { createEnvironmentSeal } from "@repo/environment";

test("the development auth bypass requires the sealed local runtime gates", () => {
  assert.equal(devAuthBypassEnabled(localAuthEnvironment()), true);
  assert.equal(devAuthBypassEnabled(localAuthEnvironment({ NODE_ENV: "production" })), false);
  assert.equal(devAuthBypassEnabled(localAuthEnvironment({ DEV_AUTH_BYPASS: "TRUE" })), false);
  assert.equal(devAuthBypassEnabled(localAuthEnvironment({ TRACERA_PROFILE: "test" })), false);
  assert.equal(
    devAuthBypassEnabled(localAuthEnvironment({ TRACERA_CONFIG_ROLE: "migration" })),
    false,
  );
});

test("local auth accepts only the configured loopback origin", () => {
  const environment = localAuthEnvironment();
  assert.equal(localAuthIdentities(environment, `${environment.TRACERA_APP_ORIGIN}/`)?.length, 2);
  assert.equal(localAuthIdentities(environment, "http://localhost:3000/"), null);
  assert.equal(localAuthIdentities(environment, "https://dev.tracera.test/"), null);
});

test("local auth has no social providers and uses an HTTP-compatible session cookie", () => {
  const environment = localAuthEnvironment();
  const auth = createAuth(environment, `${environment.TRACERA_APP_ORIGIN}/api/auth/get-session`);

  assert.deepEqual(auth.options.socialProviders, {});
  assert.deepEqual(auth.options.trustedOrigins, [environment.TRACERA_APP_ORIGIN]);
  assert.equal(auth.options.advanced?.useSecureCookies, false);
});

test("deployed auth keeps the hosted origin, OAuth providers, and secure cookies", () => {
  const environment = deployedAuthEnvironment();
  const auth = createAuth(environment, "http://localhost:3000/api/auth/sign-in/social");

  assert.equal(auth.options.baseURL, "https://tracera.voltcrash.com");
  assert.deepEqual(Object.keys(auth.options.socialProviders ?? {}), ["google"]);
  assert.equal(auth.options.advanced?.useSecureCookies, true);
});

test("the development login endpoint is not registered in deployed configuration", async () => {
  const environment = deployedAuthEnvironment({
    DEV_AUTH_BYPASS: "true",
    NODE_ENV: "development",
  });
  const url = `https://tracera.voltcrash.com/api/auth${DEV_AUTH_BYPASS_PATH}?identity=ada`;
  const auth = createAuth(environment, url);
  const response = await auth.handler(new Request(url));

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("the development login endpoint rejects unknown identities", async () => {
  const environment = localAuthEnvironment();
  const url = `${environment.TRACERA_APP_ORIGIN}/api/auth${DEV_AUTH_BYPASS_PATH}?identity=unknown`;
  const auth = createAuth(environment, url);
  const response = await auth.handler(new Request(url));

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("set-cookie"), null);
});

function localAuthEnvironment(overrides: Record<string, string> = {}) {
  const environment: Record<string, string> = {
    TRACERA_PROFILE: "local",
    TRACERA_CONFIG_ROLE: "runtime",
    TRACERA_CONFIG_SOURCE: "generated-worktree",
    TRACERA_WORKTREE_ID: "auth_test",
    TRACERA_DATABASE_HOST: "127.0.0.1",
    TRACERA_DATABASE_PORT: "25432",
    TRACERA_DATABASE_NAME: "tracera_auth_test_dev",
    TRACERA_APP_ORIGIN: "http://127.0.0.1:4173",
    TRACERA_APP_PORT: "4173",
    DATABASE_URL:
      "postgresql://tracera_runtime:database-password@127.0.0.1:25432/tracera_auth_test_dev",
    BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
    DEV_AUTH_BYPASS: "true",
    NODE_ENV: "development",
    ...overrides,
  };
  environment.TRACERA_CONFIG_SEAL = createEnvironmentSeal(environment);
  return environment;
}

function deployedAuthEnvironment(overrides: Record<string, string> = {}) {
  return {
    TRACERA_PROFILE: "deployed",
    TRACERA_CONFIG_ROLE: "runtime",
    DATABASE_URL: "postgresql://tracera_runtime:password@database.example/tracera",
    BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    NODE_ENV: "production",
    ...overrides,
  };
}
