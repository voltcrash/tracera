import type { AuthUser } from "@repo/db";

export type AuthBindings = Record<never, never>;

export function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isValidEmail(email: string) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function authenticatedUser(
  _request: Request,
  _env: AuthBindings,
): Promise<AuthUser | null> {
  return null;
}
