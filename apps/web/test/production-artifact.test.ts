import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { validateArtifact, writeArtifact } from "../scripts/production-artifact";

let directory: string;
let config: Record<string, any>;
const buildId = `${"a".repeat(40)}-100-2`;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "tracera-artifact-"));
  config = JSON.parse(
    await readFile(new URL("../wrangler.production.json", import.meta.url), "utf8"),
  );
  await mkdir(join(directory, "client"));
  await mkdir(join(directory, "server"));
  await writeFile(join(directory, "client/version.json"), JSON.stringify({ version: buildId }));
  await writeFile(join(directory, "client/app.js"), "console.log('fixture');");
  await writeFile(
    join(directory, "server/wrangler.json"),
    JSON.stringify({ ...config, vars: { ...config.vars, VERSION: buildId } }),
  );
  await writeFile(join(directory, "server/.dev.vars"), "private-preview-value");
  await writeArtifact(directory, buildId);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("seals matching client and Worker files without archiving preview secrets", async () => {
  expect(await validateArtifact(directory, config)).toBe(buildId);
  await expect(readFile(join(directory, "server/.dev.vars"))).rejects.toThrow();
  expect(await readFile(join(directory, "artifact.json"), "utf8")).not.toContain(
    "private-preview-value",
  );
});

test.each(["changed", "added", "removed"])("rejects %s artifact files", async (operation) => {
  const file = join(directory, "client/app.js");
  if (operation === "changed") await writeFile(file, "changed");
  else if (operation === "added") await writeFile(join(directory, "client/extra.js"), "added");
  else await rm(file);
  await expect(validateArtifact(directory, config)).rejects.toThrow("artifact changed");
});

test.each([
  "name",
  "account_id",
  "routes",
  "workflows",
  "r2_buckets",
  "triggers",
  "secrets",
  "workers_dev",
  "compatibility_date",
])("rejects different %s deployment settings", async (key) => {
  await expect(validateArtifact(directory, { ...config, [key]: "different" })).rejects.toThrow(
    `different ${key}`,
  );
});

test("rejects production resource or public-setting changes after build", async () => {
  await expect(
    validateArtifact(directory, {
      ...config,
      d1_databases: [{ ...config.d1_databases[0], database_id: "other" }],
    }),
  ).rejects.toThrow("D1 resources");
  await expect(
    validateArtifact(directory, {
      ...config,
      vars: { ...config.vars, BETTER_AUTH_URL: "https://other.example" },
    }),
  ).rejects.toThrow("BETTER_AUTH_URL");
});

test.each(["worker", "client"])(
  "rejects mismatched %s build identity even after resealing",
  async (target) => {
    if (target === "worker")
      await writeFile(join(directory, "server/wrangler.json"), JSON.stringify(config));
    else
      await writeFile(
        join(directory, "client/version.json"),
        JSON.stringify({ version: "other-build" }),
      );
    await writeArtifact(directory, buildId);
    await expect(validateArtifact(directory, config)).rejects.toThrow("share one build ID");
  },
);

test.each([".env", ".env.production", ".dev.vars.production"])(
  "rejects private %s files",
  async (name) => {
    await writeFile(join(directory, "client", name), "private-fixture");
    await expect(writeArtifact(directory, buildId)).rejects.toThrow("Private settings");
  },
);

test("rejects symlinks that could escape the fingerprinted tree", async () => {
  await symlink(join(directory, "server/wrangler.json"), join(directory, "client/link.json"));
  await expect(writeArtifact(directory, buildId)).rejects.toThrow("symbolic links");
});

test("artifact paths accept directory URLs with a trailing slash", async () => {
  await writeArtifact(`${directory}/`, buildId);
  expect(await validateArtifact(`${directory}/`, config)).toBe(buildId);
});
