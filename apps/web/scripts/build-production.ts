import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBuildId } from "./build-id";
import { writeArtifact } from "./production-artifact";
import { validateProductionInputs } from "./production-inputs";
import { readProductionSettings } from "./production-settings";

async function main() {
  validateProductionInputs(await readProductionSettings());
  const buildId = resolveBuildId(false);
  const result = spawnSync("vp", ["build"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: "wrangler.production.json",
      TRACERA_BUILD_ID: buildId,
    },
    stdio: "inherit",
  });
  if (result.error || result.status !== 0)
    throw new Error("Production build failed; deployment stopped");
  await writeArtifact(fileURLToPath(new URL("../dist/", import.meta.url)), buildId);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Production build failed");
  process.exitCode = 1;
});
