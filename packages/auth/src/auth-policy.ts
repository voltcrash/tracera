import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";

export const TRACERA_AUTH_BASE_PATH = "/api/auth";
export const DEV_AUTH_BYPASS_PATH = "/dev-login";
export const DEV_AUTH_IDENTITIES_PATH = "/dev-identities";

export const LOCAL_AUTH_IDENTITIES = [
  { id: "ada", email: "ada@tracera.local", name: "Ada Local" },
  { id: "grace", email: "grace@tracera.local", name: "Grace Local" },
] as const;

export function discardOAuthTokenMaterial() {
  return {
    data: {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    },
  };
}

export function devAuthBypass(
  identities: typeof LOCAL_AUTH_IDENTITIES,
  allowedOrigin?: string,
): BetterAuthPlugin {
  const allowed = (request: Request | undefined): request is Request =>
    Boolean(
      request &&
      isLoopbackHostname(new URL(request.url).hostname) &&
      (!allowedOrigin || new URL(request.url).origin === allowedOrigin),
    );
  return {
    id: "tracera-dev-auth-bypass",
    endpoints: {
      devIdentities: createAuthEndpoint(
        DEV_AUTH_IDENTITIES_PATH,
        { method: "GET", metadata: { scope: "server" } },
        async (context) => {
          if (!allowed(context.request)) throw context.error("NOT_FOUND");
          return context.json({ identities: identities.map(({ id, name }) => ({ id, name })) });
        },
      ),
      devLogin: createAuthEndpoint(
        DEV_AUTH_BYPASS_PATH,
        { method: "GET", metadata: { scope: "server" } },
        async (context) => {
          const request = context.request;
          if (!allowed(request)) throw context.error("NOT_FOUND");
          const identityId = new URL(request.url).searchParams.get("identity") ?? "";
          const identity = identities.find((candidate) => candidate.id === identityId);
          if (!identity) throw context.error("NOT_FOUND");

          const adapter = context.context.internalAdapter;
          const existingUser = await adapter.findUserByEmail(identity.email);
          let user = existingUser?.user;
          if (!user) {
            try {
              user = await adapter.createUser(
                {
                  email: identity.email,
                  name: identity.name,
                  emailVerified: true,
                },
                { method: "dev-auth-bypass" },
              );
            } catch (error) {
              user = (await adapter.findUserByEmail(identity.email))?.user;
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

export function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
