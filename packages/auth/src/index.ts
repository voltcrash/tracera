import { dash } from "@better-auth/infra";
import { randomAvatarId } from "@repo/contracts/avatar";
import { db } from "@repo/db";
import * as databaseSchema from "@repo/db/schema";
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";

export const TRACERA_AUTH_BASE_PATH = "/api/auth";
export const DEV_AUTH_BYPASS_PATH = "/dev-login";

const DEV_USER = {
  email: "developer@tracera.local",
  name: "Tracera Developer",
} as const;

export type AuthRuntimeEnv = {
  NODE_ENV?: string;
  DEV_AUTH_BYPASS?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_API_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

export function devAuthBypassEnabled(env: Pick<AuthRuntimeEnv, "NODE_ENV" | "DEV_AUTH_BYPASS">) {
  return env.NODE_ENV === "development" && env.DEV_AUTH_BYPASS === "true";
}

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
    session: {
      modelName: "sessions",
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
    emailAndPassword: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          /* Avatars are Tracera's own marks, so a provider photo never applies. */
          before: async (user) => ({ data: { ...user, image: randomAvatarId() } }),
        },
      },
    },
    socialProviders: {
      google: {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        scope: ["openid", "email", "profile"],
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

function devAuthBypass() {
  return {
    id: "tracera-dev-auth-bypass",
    endpoints: {
      devLogin: createAuthEndpoint(
        DEV_AUTH_BYPASS_PATH,
        { method: "GET", metadata: { scope: "server" } },
        async (context) => {
          const request = context.request;
          if (!request || !isLoopbackHostname(new URL(request.url).hostname)) {
            throw context.error("NOT_FOUND");
          }

          const adapter = context.context.internalAdapter;
          const existingUser = await adapter.findUserByEmail(DEV_USER.email);
          let user = existingUser?.user;
          if (!user) {
            try {
              user = await adapter.createUser(
                {
                  ...DEV_USER,
                  emailVerified: true,
                },
                { method: "dev-auth-bypass" },
              );
            } catch (error) {
              user = (await adapter.findUserByEmail(DEV_USER.email))?.user;
              if (!user) throw error;
            }
          }
          const session = await adapter.createSession(user.id);

          await setSessionCookie(context, { session, user });
          throw context.redirect(new URL("/home", request.url).toString());
        },
      ),
    },
  };
}

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export type TraceraAuth = ReturnType<typeof createAuth>;
