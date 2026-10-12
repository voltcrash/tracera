import { createAuth, localAuthIdentities } from "@repo/auth/d1";
import { createD1Database } from "@repo/db/d1";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { serverEnv, type ServerEnv } from "./env";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  image: string | null;
  createdAt: string;
};
export type SocialProvider = "google" | "github";
export type SignInOptions = {
  providers: SocialProvider[];
  identities: { id: string; name: string }[] | null;
};

export function authFor(env: ServerEnv, request: Request) {
  return createAuth({
    db: createD1Database(env.DB),
    env,
    origin: new URL(request.url).origin,
  });
}

export async function readSessionUser(
  env: ServerEnv,
  request: Request,
): Promise<SessionUser | null> {
  const session = await authFor(env, request).api.getSession({ headers: request.headers });
  if (!session) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? "",
    image: session.user.image ?? null,
    createdAt: new Date(session.user.createdAt).toISOString(),
  };
}

const complete = (id?: string, secret?: string) => Boolean(id?.trim() && secret?.trim());

/** Offers only providers whose credential pair is complete, as createAuth enables them. */
export function signInOptions(env: ServerEnv, origin: string): SignInOptions {
  const providers: SocialProvider[] = [];
  if (complete(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET)) providers.push("google");
  if (complete(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET)) providers.push("github");
  const identities = localAuthIdentities(env, origin);
  return {
    providers,
    identities: identities ? identities.map(({ id, name }) => ({ id, name })) : null,
  };
}

export const getSession = createServerFn({ method: "GET" }).handler(() =>
  readSessionUser(serverEnv(), getRequest()),
);

export const getSignInOptions = createServerFn({ method: "GET" }).handler(() =>
  signInOptions(serverEnv(), new URL(getRequest().url).origin),
);
