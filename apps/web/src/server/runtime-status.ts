import { createServerFn } from "@tanstack/react-start";
import { serverEnv } from "./env";

export const getRuntimeStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { ANALYSIS_MODE, DB, MODE, VERSION } = serverEnv();
  const migrations = await DB.prepare("SELECT count(*) AS applied FROM d1_migrations")
    .first<{ applied: number }>()
    .then((row) => row?.applied ?? 0)
    .catch(() => 0);
  return { mode: MODE, analysisMode: ANALYSIS_MODE, version: VERSION, migrations };
});
