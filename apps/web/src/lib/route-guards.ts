import { redirect } from "@tanstack/react-router";
import type { SessionUser } from "@/server/session";

/** Workspace pages need a session; anonymous visitors go to the landing page. */
export function requireUser(user: SessionUser | null) {
  if (!user) throw redirect({ to: "/" });
  return user;
}

/** The landing page is for anonymous visitors; signed-in users go to their workspace. */
export function redirectSignedIn(user: SessionUser | null) {
  if (user) throw redirect({ to: "/home" });
}
