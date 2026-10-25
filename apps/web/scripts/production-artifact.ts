import { createHash } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const receiptSchema = z.object({
  buildId: z.string().regex(/^[\w.-]{1,64}$/),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});

async function fingerprints(directory: string) {
  const root = resolve(directory);
  const files: Record<string, string> = {};
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries.sort((a, b) =>
    resolve(a.parentPath, a.name).localeCompare(resolve(b.parentPath, b.name)),
  )) {
    if (entry.isSymbolicLink())
      throw new Error("Production artifacts cannot contain symbolic links");
    if (!entry.isFile()) continue;
    const name = resolve(entry.parentPath, entry.name).slice(root.length + 1);
    if (name === "artifact.json") continue;
    if (name.split("/").some((part) => /^\.dev\.vars|^\.env(?:\.|$)/.test(part)))
      throw new Error("Private settings cannot be part of a production artifact");
    files[name] = createHash("sha256")
      .update(await readFile(resolve(root, name)))
      .digest("hex");
  }
  return files;
}

export async function writeArtifact(directory: string, buildId: string) {
  await rm(resolve(directory, "server/.dev.vars"), { force: true });
  const receipt = receiptSchema.parse({ buildId, files: await fingerprints(directory) });
  await writeFile(resolve(directory, "artifact.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

const artifactConfigSchema = z
  .object({
    vars: z.record(z.string(), z.unknown()),
    d1_databases: z.array(
      z.object({ binding: z.string(), database_id: z.string(), database_name: z.string() }),
    ),
  })
  .catchall(z.unknown());

export async function validateArtifact(directory: string, value: unknown) {
  const config = artifactConfigSchema.parse(value);
  const receipt = receiptSchema.parse(
    JSON.parse(await readFile(resolve(directory, "artifact.json"), "utf8")),
  );
  if (JSON.stringify(await fingerprints(directory)) !== JSON.stringify(receipt.files))
    throw new Error("Production artifact changed; run build:production again");
  const built = artifactConfigSchema.parse(
    JSON.parse(await readFile(resolve(directory, "server/wrangler.json"), "utf8")),
  );
  for (const key of [
    "name",
    "account_id",
    "routes",
    "workflows",
    "r2_buckets",
    "triggers",
    "secrets",
    "workers_dev",
    "preview_urls",
    "observability",
    "compatibility_date",
    "compatibility_flags",
  ]) {
    if (JSON.stringify(built[key]) !== JSON.stringify(config[key]))
      throw new Error(`Production artifact has a different ${key}`);
  }
  const identity = (databases: Array<Record<string, unknown>>) =>
    databases.map(({ binding, database_id, database_name }) => ({
      binding,
      database_id,
      database_name,
    }));
  if (
    JSON.stringify(identity(built.d1_databases)) !== JSON.stringify(identity(config.d1_databases))
  )
    throw new Error("Production artifact has different D1 resources");
  for (const [key, value] of Object.entries(config.vars)) {
    if (key !== "VERSION" && built.vars?.[key] !== value)
      throw new Error(`Production artifact has a different ${key} setting`);
  }
  const version = JSON.parse(await readFile(resolve(directory, "client/version.json"), "utf8"));
  if (built.vars?.VERSION !== receipt.buildId || version.version !== receipt.buildId)
    throw new Error("Production Worker and client must share one build ID");
  return receipt.buildId;
}
