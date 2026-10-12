import { copyFileSync, existsSync, readFileSync, chmodSync, constants } from "node:fs";
import { parseEnv } from "node:util";

const path = new URL("../.dev.vars", import.meta.url);
if (!existsSync(path)) {
  copyFileSync(new URL("../.dev.vars.example", import.meta.url), path, constants.COPYFILE_EXCL);
  chmodSync(path, 0o600);
}
const settings = parseEnv(readFileSync(path, "utf8"));
for (const [name, required] of Object.entries({
  MODE: "dev",
  ANALYSIS_MODE: "fixture",
  DEV_AUTH_BYPASS: "true",
})) {
  if (settings[name] !== required)
    throw new Error(`Browser tests require ${name}=${required} in .dev.vars.`);
}
