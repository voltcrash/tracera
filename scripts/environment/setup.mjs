import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findLegacyEnvironmentFiles } from "../../packages/environment/src/loader.js";

const rootDirectory = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const worktreePath = realpathSync(rootDirectory);
const digest = createHash("sha256").update(worktreePath).digest("hex");
const readableName = basename(worktreePath)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .slice(0, 20);
const worktreeId = `${readableName}_${digest.slice(0, 8)}`;
const databasePort = String(20_000 + (Number.parseInt(digest.slice(0, 6), 16) % 20_000));
const environmentRoot = `${rootDirectory}/.tracera/environment`;

const legacyEnvironmentFiles = findLegacyEnvironmentFiles(rootDirectory);
if (legacyEnvironmentFiles.length > 0) {
  console.error(
    `Legacy environment file detected (${legacyEnvironmentFiles.join(", ")}). Move it outside the repository before generating isolated configuration; its contents were not read.`,
  );
  process.exit(1);
}

for (const profile of ["local", "test"]) {
  const profileDirectory = `${environmentRoot}/${profile}`;
  mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
  chmodSync(profileDirectory, 0o700);
  const databaseName = `tracera_${worktreeId}_${profile === "local" ? "dev" : "test"}`;
  writeExclusive(
    `${profileDirectory}/shared.env`,
    [
      `TRACERA_WORKTREE_ID=${worktreeId}`,
      "TRACERA_DATABASE_HOST=127.0.0.1",
      `TRACERA_DATABASE_PORT=${databasePort}`,
      `TRACERA_DATABASE_NAME=${databaseName}`,
    ].join("\n"),
  );
  writeExclusive(
    `${profileDirectory}/runtime.env`,
    [
      `DATABASE_URL=${postgresUrl("tracera_runtime", secret(), databasePort, databaseName)}`,
      `BETTER_AUTH_SECRET=${secret(48)}`,
    ].join("\n"),
  );
  writeExclusive(
    `${profileDirectory}/migration.env`,
    `DATABASE_MIGRATOR_URL=${postgresUrl("tracera_migrator", secret(), databasePort, databaseName)}`,
  );
  writeExclusive(
    `${profileDirectory}/test-provisioning.env`,
    `TEST_DATABASE_PROVISIONER_URL=${postgresUrl("tracera_test_provisioner", secret(), databasePort, "postgres")}`,
  );
  writeExclusive(
    `${profileDirectory}/analysis.env`,
    "# Offline fixture configuration is added by L05.",
  );
}

console.error(`Generated isolated Tracera configuration for worktree ${worktreeId}.`);
console.error(
  `Database target: 127.0.0.1:${databasePort} (PostgreSQL provisioning begins in L02).`,
);

function secret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function postgresUrl(username, password, port, database) {
  return `postgresql://${username}:${password}@127.0.0.1:${port}/${database}`;
}

function writeExclusive(path, content) {
  if (existsSync(path)) return;
  writeFileSync(path, `${content}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}
