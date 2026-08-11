import { expo } from "@better-auth/expo";
import { dash } from "@better-auth/infra";
import { db } from "@repo/db";
import * as databaseSchema from "@repo/db/schema";
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";

export const TRACERA_AUTH_BASE_URL = "https://tracera.voltcrash.com";
export const TRACERA_AUTH_BASE_PATH = "/api/auth";
export const TRACERA_SESSION_COOKIE = "tracera.session_token";
export const TRACERA_EXTENSION_ID = "pojehdamemgikkedidbdpopegjfoglih";
export const TRACERA_EXTENSION_ORIGIN = `chrome-extension://${TRACERA_EXTENSION_ID}`;

export type AuthRuntimeEnv = {
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_API_KEY?: string;
  BETTER_AUTH_API_URL?: string;
  BETTER_AUTH_KV_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

export function createAuth(env: AuthRuntimeEnv) {
  const secret = required(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET");
  const googleClientId = required(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
  const googleClientSecret = required(
    env.GOOGLE_CLIENT_SECRET,
    "GOOGLE_CLIENT_SECRET",
  );

  return betterAuth({
    appName: "Tracera",
    baseURL: TRACERA_AUTH_BASE_URL,
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
      TRACERA_AUTH_BASE_URL,
      "https://dash.better-auth.com",
      TRACERA_EXTENSION_ORIGIN,
      "tracera://",
      "tracera://*",
      ...(process.env.NODE_ENV === "development"
        ? ["http://localhost:3000", "exp://**"]
        : []),
    ],
    advanced: {
      database: { generateId: "uuid" },
      cookiePrefix: "tracera",
      useSecureCookies: true,
    },
    plugins: [
      bearer(),
      expo(),
      dash({
        apiKey: required(env.BETTER_AUTH_API_KEY, "BETTER_AUTH_API_KEY"),
        apiUrl: env.BETTER_AUTH_API_URL,
        kvUrl: env.BETTER_AUTH_KV_URL,
      }),
    ],
  });
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} must be configured.`);
  return value;
}

export type TraceraAuth = ReturnType<typeof createAuth>;
