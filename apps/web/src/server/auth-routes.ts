import { createAuth, type AuthRuntimeEnv } from "@repo/auth";
import { configureDatabase } from "@repo/db";
import { Hono } from "hono";

export type AuthRoutesBindings = AuthRuntimeEnv & { DATABASE_URL?: string };

export const authRoutes = new Hono<{ Bindings: AuthRoutesBindings }>();

authRoutes.all("/*", async (context) => {
  configureDatabase(context.env.DATABASE_URL ?? process.env.DATABASE_URL);
  // Better Auth resolves its own routes from the full request URL, which Hono
  // leaves untouched on `raw` even when this app is mounted under a prefix.
  return createAuth(context.env, context.req.url).handler(context.req.raw);
});
