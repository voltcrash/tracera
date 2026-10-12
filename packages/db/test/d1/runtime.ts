import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

export async function createTestRuntime() {
  const runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "tracera-test" },
    r2Buckets: ["BLOBS"],
  });
  try {
    const db = (await runtime.getD1Database("DB")) as unknown as D1Database;
    const bucket = (await runtime.getR2Bucket("BLOBS")) as unknown as R2Bucket;
    const migrations = new URL("../../migrations/", import.meta.url);
    for (const file of (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort()) {
      const statements = (await readFile(new URL(file, migrations), "utf8"))
        .split("--> statement-breakpoint")
        .filter((statement) => statement.trim());
      await db.batch(statements.map((statement) => db.prepare(statement)));
    }
    return { db, bucket, dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export async function seedUser(db: D1Database, id = "user-1") {
  await db
    .prepare("INSERT INTO users (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, id, `${id}@tracera.local`, 0, 0)
    .run();
}
