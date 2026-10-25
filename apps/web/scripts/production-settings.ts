import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { experimental_readRawConfig } from "wrangler";

const app = new URL("../", import.meta.url);

async function optionalFile(name: string) {
  try {
    return await readFile(new URL(name, app), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readProductionSettings() {
  const secrets = await optionalFile(".dev.vars.production");
  if (secrets === undefined)
    throw new Error("Create apps/web/.dev.vars.production from .dev.vars.production.example.");
  const staging = await optionalFile(".dev.vars.staging");
  const config = (name: string) =>
    experimental_readRawConfig({ config: fileURLToPath(new URL(name, app)) }).rawConfig;
  return {
    config: config("wrangler.production.json"),
    stagingConfig: config("wrangler.jsonc"),
    secrets: parseEnv(secrets),
    stagingSecrets: staging === undefined ? undefined : parseEnv(staging),
  };
}
