import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeProductionWorkerEnv({ cwd, environment }) {
  for (const name of ["CLOUDFLARE_API_TOKEN", "PRODUCTION_WORKER_ENV"])
    if (!environment[name]?.trim())
      throw new Error(`Configure the production Actions input ${name}`);
  const path = join(cwd, "apps/web/.dev.vars.production");
  writeFileSync(path, environment.PRODUCTION_WORKER_ENV, { mode: 0o600, flag: "wx" });
  return path;
}
