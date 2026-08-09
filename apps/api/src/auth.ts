import { createClerkClient, verifyToken } from "@clerk/backend";
import { findUserByClerkId, linkUserToClerk, type AuthUser } from "@repo/db";

export type ClerkBindings = {
  CLERK_SECRET_KEY?: string;
  CLERK_JWT_KEY?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
};

export function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isValidEmail(email: string) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Verify a Clerk session token and resolve it to Tracera's local user row.
 * Clerk owns credentials and sessions; the local row only owns product data.
 */
export async function authenticatedUser(
  request: Request,
  env: ClerkBindings,
): Promise<AuthUser | null> {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token || !env.CLERK_JWT_KEY) return null;

  try {
    const authorizedParties = env.CLERK_AUTHORIZED_PARTIES?.split(",")
      .map((party) => party.trim())
      .filter(Boolean);
    const claims = await verifyToken(token, {
      jwtKey: env.CLERK_JWT_KEY.replace(/\\n/g, "\n"),
      ...(authorizedParties?.length ? { authorizedParties } : {}),
    });
    const existing = await findUserByClerkId(claims.sub);
    if (existing) return existing;
    if (!env.CLERK_SECRET_KEY) return null;

    const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
    const identity = await clerk.users.getUser(claims.sub);
    const primaryEmail = identity.emailAddresses.find(
      (candidate) => candidate.id === identity.primaryEmailAddressId,
    );
    const email = normalizeEmail(primaryEmail?.emailAddress);
    if (!isValidEmail(email)) return null;

    return linkUserToClerk({ clerkUserId: identity.id, email });
  } catch (error) {
    console.warn("Clerk session verification failed", error);
    return null;
  }
}

function bearerToken(authorization: string | null) {
  return authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
}
