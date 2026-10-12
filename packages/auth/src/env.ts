import type { BetterAuthOptions } from "better-auth";
import { isLoopbackHostname, LOCAL_AUTH_IDENTITIES } from "#auth-policy";

export interface WorkerAuthEnv {
  MODE: "dev" | "production";
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  DEV_AUTH_BYPASS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

export function devAuthBypassEnabled(env: WorkerAuthEnv, origin: string | URL): boolean {
  try {
    const url = new URL(origin);
    return (
      env.MODE === "dev" &&
      env.DEV_AUTH_BYPASS === "true" &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      isLoopbackHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

export function localAuthIdentities(env: WorkerAuthEnv, origin: string | URL) {
  return devAuthBypassEnabled(env, origin) ? LOCAL_AUTH_IDENTITIES : null;
}

export function resolveAuthConfiguration(
  env: WorkerAuthEnv,
  origin: string | URL,
): {
  baseURL: string;
  secret: string;
  secureCookies: boolean;
  socialProviders: NonNullable<BetterAuthOptions["socialProviders"]>;
  localIdentities: typeof LOCAL_AUTH_IDENTITIES | null;
} {
  if (env.MODE !== "dev" && env.MODE !== "production")
    throw new Error("MODE must be dev or production.");
  const secret = required(env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET");
  if (secret.length < 32)
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
  let requestOrigin: string;
  try {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error();
    requestOrigin = url.origin;
  } catch {
    throw new Error("Auth request origin must be HTTP or HTTPS.");
  }
  let baseURL = requestOrigin;
  if (env.MODE === "production") {
    try {
      const url = new URL(required(env.BETTER_AUTH_URL, "BETTER_AUTH_URL"));
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error();
      baseURL = url.origin;
    } catch {
      throw new Error("BETTER_AUTH_URL must be one HTTPS origin.");
    }
  }
  const google = credentials(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, "Google");
  const github = credentials(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, "GitHub");
  if (env.MODE === "production" && !github)
    throw new Error("GitHub credentials must be configured in production.");
  return {
    baseURL,
    secret,
    secureCookies: env.MODE === "production",
    socialProviders: {
      ...(google ? { google: { ...google, scope: ["openid", "email", "profile"] } } : {}),
      ...(github ? { github } : {}),
    },
    localIdentities: localAuthIdentities(env, requestOrigin),
  };
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} must be configured.`);
  return value;
}
function credentials(id: string | undefined, secret: string | undefined, provider: string) {
  if (Boolean(id?.trim()) !== Boolean(secret?.trim()))
    throw new Error(`${provider} client ID and client secret must be configured together.`);
  return id?.trim() && secret?.trim() ? { clientId: id, clientSecret: secret } : null;
}
