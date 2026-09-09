import { dash } from "@better-auth/infra";
import { db } from "@repo/db";
import * as databaseSchema from "@repo/db/schema";
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { devAuthBypass, devAuthBypassEnabled } from "./dev-auth-bypass.js";

export { DEV_AUTH_BYPASS_PATH, devAuthBypassEnabled } from "./dev-auth-bypass.js";

export const TRACERA_AUTH_BASE_PATH = "/api/auth";

export type AuthRuntimeEnv = {
  NODE_ENV?: string;
  DEV_AUTH_BYPASS?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_API_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

export function createAuth(env: AuthRuntimeEnv, requestUrl: string | URL) {
  const secret = required(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET");
  const googleClientId = required(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
  const googleClientSecret = required(env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET");
  const baseURL = new URL(requestUrl).origin;

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
    session: { modelName: "sessions" },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        scope: ["openid", "email", "profile"],
        prompt: "select_account",
      },
    },
    trustedOrigins: [
      baseURL,
      "https://dash.better-auth.com",
      ...(process.env.NODE_ENV === "development" ? ["http://localhost:3000"] : []),
    ],
    onAPIError: {
      errorURL: "/auth/error",
    },
    advanced: {
      database: { generateId: "uuid" },
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
      },
      cookiePrefix: "tracera",
      useSecureCookies: true,
    },
    plugins: [
      ...(env.BETTER_AUTH_API_KEY ? [dash({ apiKey: env.BETTER_AUTH_API_KEY })] : []),
      ...(devAuthBypassEnabled(env) ? [devAuthBypass()] : []),
    ],
  });
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} must be configured.`);
  return value;
}

export type TraceraAuth = ReturnType<typeof createAuth>;
