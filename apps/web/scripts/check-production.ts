import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateArtifact } from "./production-artifact";
import { validateProductionInputs } from "./production-inputs";
import { readProductionSettings } from "./production-settings";

async function main() {
  const settings = await readProductionSettings();
  const built = JSON.parse(
    await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"),
  );
  const { analysis } = validateProductionInputs({ ...settings, built });
  const buildId = await validateArtifact(
    fileURLToPath(new URL("../dist/", import.meta.url)),
    settings.config,
  );
  console.log(`Production configuration, secrets and artifact checked: ${buildId}`);
  if (!analysis) console.log("No AI provider is configured; analysis stays unavailable.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Production checks failed");
  process.exitCode = 1;
});
