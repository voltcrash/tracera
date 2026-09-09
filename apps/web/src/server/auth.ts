import { createAuth, type AuthRuntimeEnv } from "@repo/auth";
import type { AuthUser } from "@repo/db";
import { logServerWarning } from "./error-handling";

export type AuthBindings = AuthRuntimeEnv;

export function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isValidEmail(email: string) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function authenticatedUser(
  request: Request,
  env: AuthBindings,
): Promise<AuthUser | null> {
  try {
    const session = await createAuth(env, request.url).api.getSession({
      headers: request.headers,
    });
    if (!session) return null;
    return {
      id: session.user.id,
      email: session.user.email,
      createdAt: session.user.createdAt.toISOString(),
    };
  } catch (error) {
    logServerWarning("Session verification failed", error, request);
    return null;
  }
}
