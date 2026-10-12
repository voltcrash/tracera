import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { experimental_readRawConfig } from "wrangler";
import { validateProductionInputs } from "./production-inputs";

const app = new URL("../", import.meta.url);
const path = (name: string) => new URL(name, app).pathname;

async function readOptional(name: string) {
  try {
    return await readFile(path(name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function main() {
  const secrets = await readOptional(".dev.vars.production");
  if (secrets === undefined)
    throw new Error("Create apps/web/.dev.vars.production from .dev.vars.production.example.");
  const built = await readOptional("dist/server/wrangler.json");
  if (built === undefined) throw new Error("Run build:production before checking production.");
  const stagingSecrets = await readOptional(".dev.vars.staging");
  validateProductionInputs({
    config: experimental_readRawConfig({ config: path("wrangler.production.json") }).rawConfig,
    stagingConfig: experimental_readRawConfig({ config: path("wrangler.jsonc") }).rawConfig,
    secrets: parseEnv(secrets),
    stagingSecrets: stagingSecrets === undefined ? undefined : parseEnv(stagingSecrets),
    built: JSON.parse(built),
  });
  console.log("Production configuration, secrets and build checked.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Production checks failed.");
  process.exitCode = 1;
});
