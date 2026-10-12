import { redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { serverEnv } from "./env";
import { readSessionUser } from "./session.server";

/** Server functions behind this middleware see the D1 session user; anonymous callers go home. */
export const authMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const user = await readSessionUser(serverEnv(), getRequest());
  if (!user) throw redirect({ to: "/" });
  return next({ context: { user } });
});
