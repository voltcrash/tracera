import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import {
  createAuthSession,
  createUser,
  deleteAuthSession,
  findUserByEmail,
  findUserBySessionTokenHash,
  type AuthUser,
  createAccountToken as persistAccountToken,
  consumeAccountToken as consumePersistedAccountToken,
  markEmailVerified,
  updateUserPassword,
} from "@repo/db";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const SESSION_LIFETIME_MS = 1000 * 60 * 60 * 24 * 30;

export const SESSION_COOKIE = "tracera_session";

export function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isValidEmail(email: string) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidPassword(password: unknown): password is string {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    password.length <= 128
  );
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, salt, encodedKey] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !encodedKey) return false;

  try {
    const expected = Buffer.from(encodedKey, "base64url");
    const actual = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  } catch {
    return false;
  }
}

export async function registerUser(email: string, password: string) {
  return createUser({ email, passwordHash: await hashPassword(password) });
}

export async function authenticateUser(email: string, password: string) {
  const user = await findUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.passwordHash)))
    return null;
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
  } satisfies AuthUser;
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await createAuthSession({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
  });
  return { token, expiresAt };
}

export async function getUserForSession(token: string | undefined) {
  return token ? findUserBySessionTokenHash(hashSessionToken(token)) : null;
}

export async function revokeSession(token: string | undefined) {
  if (token) await deleteAuthSession(hashSessionToken(token));
}

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createAccountActionToken(
  userId: string,
  kind: "verify_email" | "reset_password",
) {
  const token = randomBytes(32).toString("base64url");
  await persistAccountToken({
    userId,
    tokenHash: hashSessionToken(token),
    kind,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return token;
}
export async function consumeAccountActionToken(
  token: string,
  kind: "verify_email" | "reset_password",
) {
  return consumePersistedAccountToken(hashSessionToken(token), kind);
}
export { markEmailVerified, updateUserPassword };

export const sessionCookieOptions = (expiresAt?: Date) => ({
  httpOnly: true,
  // Cloudflare replaces NODE_ENV while bundling; use an explicit runtime
  // setting so production cookies cannot accidentally be sent over HTTP.
  secure:
    process.env.COOKIE_SECURE === "true" ||
    (process.env.COOKIE_SECURE !== "false" &&
      process.env.WEB_ORIGIN?.startsWith("https://")),
  sameSite: "Lax" as const,
  path: "/",
  ...(expiresAt
    ? { expires: expiresAt, maxAge: SESSION_LIFETIME_MS / 1000 }
    : {}),
});
