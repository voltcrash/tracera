import { randomAvatarId } from "@repo/contracts/avatar";
import type { createD1Database } from "@repo/db/d1";
import * as schema from "@repo/db/d1/schema";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { Auth, BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth/minimal";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { TRACERA_AUTH_BASE_PATH, devAuthBypass, discardOAuthTokenMaterial } from "#auth-policy";
import { resolveAuthConfiguration, type WorkerAuthEnv } from "./env.js";

export {
  TRACERA_AUTH_BASE_PATH,
  DEV_AUTH_BYPASS_PATH,
  DEV_AUTH_IDENTITIES_PATH,
  LOCAL_AUTH_IDENTITIES,
} from "#auth-policy";
export { devAuthBypassEnabled, localAuthIdentities, type WorkerAuthEnv } from "./env.js";
export type D1AuthDatabase = ReturnType<typeof createD1Database>;

export function createAuth(input: {
  db: D1AuthDatabase;
  env: WorkerAuthEnv;
  origin: string | URL;
}): Auth {
  const config = resolveAuthConfiguration(input.env, input.origin);
  const options: BetterAuthOptions = {
    appName: "Tracera",
    baseURL: config.baseURL,
    basePath: TRACERA_AUTH_BASE_PATH,
    secret: config.secret,
    database: drizzleAdapter(input.db, { provider: "sqlite", schema }),
    user: { modelName: "users" },
    session: { modelName: "sessions", cookieCache: { enabled: false } },
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
        create: { before: async (user) => ({ data: { ...user, image: randomAvatarId() } }) },
      },
      account: {
        create: { before: async () => discardOAuthTokenMaterial() },
        update: { before: async () => discardOAuthTokenMaterial() },
      },
    },
    socialProviders: config.socialProviders,
    trustedOrigins: [config.baseURL],
    onAPIError: { errorURL: "/auth/error" },
    advanced: {
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"] },
      cookiePrefix: "tracera",
      useSecureCookies: config.secureCookies,
    },
    plugins: [
      ...(config.localIdentities ? [devAuthBypass(config.localIdentities, config.baseURL)] : []),
      tanstackStartCookies(),
    ],
  };
  return betterAuth(options);
}
