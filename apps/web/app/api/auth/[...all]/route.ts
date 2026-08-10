import { createAuth } from "@repo/auth";
import { configureDatabase } from "@repo/db";
import { webRuntimeEnv } from "../../../lib/server-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function authHandler(request: Request) {
  const env = webRuntimeEnv();
  configureDatabase(env.DATABASE_URL);
  return createAuth(env).handler(request);
}

export { authHandler as GET, authHandler as POST };
