import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";

export const DEV_AUTH_BYPASS_PATH = "/dev-login";

const DEV_USER = {
  email: "developer@tracera.local",
  name: "Tracera Developer",
} as const;

export function devAuthBypassEnabled(env: { NODE_ENV?: string; DEV_AUTH_BYPASS?: string }) {
  return env.NODE_ENV === "development" && env.DEV_AUTH_BYPASS === "true";
}

export function devAuthBypass() {
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
