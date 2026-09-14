import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { findLegacyEnvironmentFiles } from "../../packages/environment/src/loader.js";
import { rootDirectory, worktreeIdentity } from "./worktree.mjs";

const { worktreeId, ports } = worktreeIdentity();
const environmentRoot = `${rootDirectory}/.tracera/environment`;

const legacyEnvironmentFiles = findLegacyEnvironmentFiles(rootDirectory);
if (legacyEnvironmentFiles.length > 0) {
  console.error(
    `Legacy environment file detected (${legacyEnvironmentFiles.join(", ")}). Move it outside the repository before generating isolated configuration; its contents were not read.`,
  );
  process.exit(1);
}

// L01 generated one port for both profiles; each profile now runs its own cluster.
const staleTestShared = `${environmentRoot}/test/shared.env`;
if (
  existsSync(staleTestShared) &&
  parseEnv(readFileSync(staleTestShared, "utf8")).TRACERA_DATABASE_PORT !== ports.test
) {
  console.error(
    `Generated test configuration does not use this worktree's test port ${ports.test}. It holds only disposable test credentials: delete .tracera/environment/test and rerun "vp run env:setup".`,
  );
  process.exit(1);
}

for (const profile of ["local", "test"]) {
  const profileDirectory = `${environmentRoot}/${profile}`;
  const databasePort = ports[profile];
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
      `TRACERA_APP_ORIGIN=http://localhost:${ports.web}`,
      `TRACERA_APP_PORT=${ports.web}`,
      ...(profile === "local" ? ["DEV_AUTH_BYPASS=true"] : []),
    ].join("\n"),
  );
  ensureSetting(
    `${profileDirectory}/runtime.env`,
    "TRACERA_APP_ORIGIN",
    `http://localhost:${ports.web}`,
    [`http://127.0.0.1:${ports.web}`],
  );
  ensureSetting(`${profileDirectory}/runtime.env`, "TRACERA_APP_PORT", ports.web);
  if (profile === "local")
    ensureSetting(`${profileDirectory}/runtime.env`, "DEV_AUTH_BYPASS", "true");
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
  `Targets: web http://localhost:${ports.web}, local database 127.0.0.1:${ports.local}, test database 127.0.0.1:${ports.test}.`,
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

function ensureSetting(path, key, value, replaceValues = []) {
  const current = readFileSync(path, "utf8");
  const parsed = parseEnv(current);
  if (parsed[key] === value) return;
  if (replaceValues.includes(parsed[key])) {
    const updated = current
      .split("\n")
      .map((line) => (line.startsWith(`${key}=`) ? `${key}=${value}` : line))
      .join("\n");
    writeFileSync(path, updated, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
    return;
  }
  if (parsed[key] !== undefined) {
    throw new Error(
      `${key} in ${path} does not match this worktree. Delete the generated profile directory and rerun "vp run env:setup".`,
    );
  }
  writeFileSync(path, `${current.trimEnd()}\n${key}=${value}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}
