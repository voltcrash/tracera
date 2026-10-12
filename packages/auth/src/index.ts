import { randomAvatarId } from "@repo/contracts/avatar";
import { db } from "@repo/db";
import * as databaseSchema from "@repo/db/schema";
import { assertEnvironmentConfiguration } from "@repo/environment";
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  TRACERA_AUTH_BASE_PATH,
  LOCAL_AUTH_IDENTITIES,
  devAuthBypass,
  isLoopbackHostname,
  discardOAuthTokenMaterial,
} from "#auth-policy";
export {
  TRACERA_AUTH_BASE_PATH,
  DEV_AUTH_BYPASS_PATH,
  DEV_AUTH_IDENTITIES_PATH,
  LOCAL_AUTH_IDENTITIES,
} from "#auth-policy";

const TRACERA_PRODUCTION_ORIGIN = "https://tracera.voltcrash.com";

export type AuthRuntimeEnv = {
  NODE_ENV?: string;
  DEV_AUTH_BYPASS?: string;
  TRACERA_PROFILE?: string;
  TRACERA_CONFIG_ROLE?: string;
  TRACERA_CONFIG_SOURCE?: string;
  TRACERA_CONFIG_SEAL?: string;
  TRACERA_WORKTREE_ID?: string;
  TRACERA_DATABASE_HOST?: string;
  TRACERA_DATABASE_PORT?: string;
  TRACERA_DATABASE_NAME?: string;
  TRACERA_APP_ORIGIN?: string;
  TRACERA_APP_PORT?: string;
  DATABASE_URL?: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
};

export function devAuthBypassEnabled(env: AuthRuntimeEnv) {
  if (
    env.TRACERA_PROFILE !== "local" ||
    env.TRACERA_CONFIG_ROLE !== "runtime" ||
    env.NODE_ENV !== "development" ||
    env.DEV_AUTH_BYPASS !== "true"
  ) {
    return false;
  }
  assertEnvironmentConfiguration(env, "runtime");
  return isLocalAppOrigin(env.TRACERA_APP_ORIGIN, env.TRACERA_APP_PORT);
}

export function localAuthIdentities(env: AuthRuntimeEnv, requestUrl: string | URL) {
  if (!devAuthBypassEnabled(env)) return null;
  const requestOrigin = new URL(requestUrl).origin;
  if (requestOrigin !== env.TRACERA_APP_ORIGIN) return null;
  return LOCAL_AUTH_IDENTITIES;
}

export function createAuth(env: AuthRuntimeEnv, requestUrl: string | URL) {
  const { profile } = assertEnvironmentConfiguration(env, "runtime");
  const secret = required(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET");
  const localIdentities = localAuthIdentities(env, requestUrl);
  const baseURL =
    profile === "deployed"
      ? TRACERA_PRODUCTION_ORIGIN
      : required(env.TRACERA_APP_ORIGIN, "TRACERA_APP_ORIGIN");
  const socialProviders = deployedSocialProviders(env, profile);

  return betterAuth({
    appName: "Tracera",
    baseURL,
    basePath: TRACERA_AUTH_BASE_PATH,
    secret,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        ...databaseSchema,
        user: databaseSchema.users,
        session: databaseSchema.sessions,
        account: databaseSchema.accounts,
        verification: databaseSchema.verifications,
      },
    }),
    user: { modelName: "users" },
    session: {
      modelName: "sessions",
      cookieCache: { enabled: false },
    },
    account: {
      modelName: "accounts",
      encryptOAuthTokens: true,
      updateAccountOnSignIn: false,
      storeAccountCookie: false,
      accountLinking: { enabled: true, allowDifferentEmails: false },
    },
    verification: { modelName: "verifications" },
    emailAndPassword: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          /* Avatars are Tracera's own marks, so a provider photo never applies. */
          before: async (user) => ({ data: { ...user, image: randomAvatarId() } }),
        },
      },
      account: {
        create: { before: async () => discardOAuthTokenMaterial() },
        update: { before: async () => discardOAuthTokenMaterial() },
      },
    },
    socialProviders,
    trustedOrigins: [baseURL],
    onAPIError: {
      errorURL: "/auth/error",
    },
    advanced: {
      database: { generateId: "uuid" },
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
      },
      cookiePrefix: "tracera",
      useSecureCookies: profile === "deployed",
    },
    plugins: localIdentities ? [devAuthBypass(localIdentities)] : [],
  });
}

function deployedSocialProviders(env: AuthRuntimeEnv, profile: string) {
  if (profile !== "deployed") return {};
  const googleClientId = required(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
  const googleClientSecret = required(env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET");
  const githubCredentials = optionalCredentials(
    env.GITHUB_CLIENT_ID,
    env.GITHUB_CLIENT_SECRET,
    "GitHub",
  );
  return {
    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      scope: ["openid", "email", "profile"],
    },
    ...(githubCredentials
      ? {
          github: {
            clientId: githubCredentials.clientId,
            clientSecret: githubCredentials.clientSecret,
          },
        }
      : {}),
  };
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} must be configured.`);
  return value;
}

function optionalCredentials(
  clientId: string | undefined,
  clientSecret: string | undefined,
  provider: string,
) {
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(`${provider} client ID and client secret must be configured together.`);
  }
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function isLocalAppOrigin(origin: string | undefined, port: string | undefined) {
  if (!origin || !port) return false;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      isLoopbackHostname(url.hostname) &&
      url.port === port &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}

export type TraceraAuth = ReturnType<typeof createAuth>;
