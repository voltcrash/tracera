import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { server } from "@/server/server";

export const runtime = "nodejs";
export const maxDuration = 300;
// Analyses read live data and set session cookies, so nothing here is cacheable.
export const dynamic = "force-dynamic";

let localEnvironmentLoaded = false;

const handler = (request: Request) => {
  loadLocalEnvironment();
  return server.fetch(request, process.env as Record<string, string | undefined>);
};

function loadLocalEnvironment() {
  if (localEnvironmentLoaded) return;
  localEnvironmentLoaded = true;

  const rootEnvPath = resolve(process.cwd(), "../../.env");
  if (existsSync(rootEnvPath)) loadEnvFile(rootEnvPath);
}

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as OPTIONS,
  handler as HEAD,
};
