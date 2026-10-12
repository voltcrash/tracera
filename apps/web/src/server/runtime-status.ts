import { createServerFn } from "@tanstack/react-start";
import { serverEnv } from "./env";

export const getRuntimeStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { DB, MODE, VERSION } = serverEnv();
  const migrations = await DB.prepare("SELECT count(*) AS applied FROM d1_migrations")
    .first<{ applied: number }>()
    .then((row) => row?.applied ?? 0)
    .catch(() => 0);
  return { mode: MODE, version: VERSION, migrations };
});
