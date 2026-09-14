import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { loadProfileEnvironment } from "../../packages/environment/src/loader.js";
import { rootDirectory, worktreeIdentity } from "../environment/worktree.mjs";

// Pinned by digest so every worktree and CI run starts from identical binaries.
export const POSTGRES_IMAGE =
  "pgvector/pgvector:0.8.6-pg18-trixie@sha256:78bf48b801e792f99e3ac62b5036fd3876e9be48afda16c1e331af1c75ceb2ff";
const ORBSTACK_DOCKER = "/Applications/OrbStack.app/Contents/MacOS/xbin/docker";
const LABEL_PREFIX = "dev.tracera";
const HEALTH_TIMEOUT_MS = 120_000;

export class DatabaseLifecycleError extends Error {
  constructor(message) {
    super(message);
    this.name = "DatabaseLifecycleError";
  }
}

/**
 * Resolves this worktree's generated database target for one profile. Every
 * role file is validated by the profile loader, and the generated identity must
 * match the real worktree path so copied configuration cannot address another
 * worktree's containers.
 */
export function loadDatabaseTarget(profile) {
  if (profile !== "local" && profile !== "test") {
    throw new DatabaseLifecycleError(
      "Database lifecycle commands accept only --profile local|test.",
    );
  }
  const roles =
    profile === "test" ? ["runtime", "migration", "test-provisioning"] : ["runtime", "migration"];
  const environments = Object.fromEntries(
    roles.map((role) => [
      role,
      loadProfileEnvironment({ rootDirectory, profile, role, inheritedEnv: process.env }),
    ]),
  );
  const passwords = new Map();
  for (const [role, key] of [
    ["runtime", "DATABASE_URL"],
    ["migration", "DATABASE_MIGRATOR_URL"],
    ["test-provisioning", "TEST_DATABASE_PROVISIONER_URL"],
  ]) {
    if (!environments[role]) continue;
    const url = new URL(environments[role][key]);
    passwords.set(decodeURIComponent(url.username), decodeURIComponent(url.password));
  }
  return { ...containerTarget(environments.runtime), environments, passwords };
}

/** Derives container identity from one selected, sealed environment without credentials. */
export function containerTarget(environment) {
  const profile = environment.TRACERA_PROFILE;
  if (profile !== "local" && profile !== "test") {
    throw new DatabaseLifecycleError("Only local and test profiles have worktree containers.");
  }
  const identity = worktreeIdentity();
  if (environment.TRACERA_WORKTREE_ID !== identity.worktreeId) {
    throw new DatabaseLifecycleError(
      'Generated configuration belongs to a different worktree. Remove the copied .tracera directory and run "vp run env:setup".',
    );
  }
  if (environment.TRACERA_DATABASE_PORT !== identity.ports[profile]) {
    throw new DatabaseLifecycleError(
      `Generated ${profile} configuration does not use this worktree's ${profile} port. Run "vp run env:setup" for instructions.`,
    );
  }
  const resourceName = `tracera-${identity.worktreeId}-${profile}`;
  return {
    profile,
    identity,
    passwords: new Map(),
    host: environment.TRACERA_DATABASE_HOST,
    port: environment.TRACERA_DATABASE_PORT,
    databaseName: environment.TRACERA_DATABASE_NAME,
    container: resourceName,
    volume: profile === "local" ? `${resourceName}-data` : null,
  };
}

export function describeTarget(target) {
  const storage = target.volume ? `volume ${target.volume}` : "tmpfs (discarded on stop)";
  return `${target.profile} database ${target.databaseName} at ${target.host}:${target.port} in container ${target.container}, ${storage}`;
}

let resolvedDocker;

export function docker(args, { input, env, allowFailure = false, secrets = [] } = {}) {
  const cli = resolveDocker();
  const result = spawnSync(cli.command, [...cli.prefix, ...args], {
    encoding: "utf8",
    input,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error)
    throw new DatabaseLifecycleError(`Unable to run docker: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new DatabaseLifecycleError(
      `docker ${args[0]} failed: ${redact(result.stderr || result.stdout, secrets).trim()}`,
    );
  }
  return result;
}

function resolveDocker() {
  if (resolvedDocker) return resolvedDocker;
  const commands = ["docker", ...(existsSync(ORBSTACK_DOCKER) ? [ORBSTACK_DOCKER] : [])];
  for (const command of commands) {
    for (const prefix of [[], ["--context", "orbstack"]]) {
      const probe = spawnSync(command, [...prefix, "version", "--format", "{{.Server.Version}}"], {
        encoding: "utf8",
      });
      if (probe.status === 0) {
        resolvedDocker = { command, prefix };
        return resolvedDocker;
      }
    }
  }
  throw new DatabaseLifecycleError(
    "A running Docker-compatible engine is required (for example Docker Desktop or OrbStack). Start it and retry.",
  );
}

export function inspectContainer(target) {
  const result = docker(["container", "inspect", target.container], { allowFailure: true });
  if (result.status !== 0) return null;
  const [info] = JSON.parse(result.stdout);
  assertOwnedLabels(info.Config.Labels, target, `Container ${target.container}`);
  const binding = info.HostConfig.PortBindings?.["5432/tcp"];
  if (
    binding?.length !== 1 ||
    binding[0].HostIp !== "127.0.0.1" ||
    binding[0].HostPort !== target.port
  ) {
    throw new DatabaseLifecycleError(
      `Container ${target.container} is not published only on 127.0.0.1:${target.port}; refusing to use it.`,
    );
  }
  return {
    running: info.State.Running === true,
    health: info.State.Health?.Status ?? "none",
    image: info.Config.Image,
  };
}

function assertOwnedLabels(labels = {}, target, subject) {
  const expected = ownershipLabels(target);
  const mismatched = Object.entries(expected).some(([key, value]) => labels[key] !== value);
  if (mismatched) {
    throw new DatabaseLifecycleError(
      `${subject} exists but is not this worktree's ${target.profile} database; refusing to use or modify it.`,
    );
  }
}

function ownershipLabels(target) {
  return {
    [`${LABEL_PREFIX}.managed`]: "true",
    [`${LABEL_PREFIX}.profile`]: target.profile,
    [`${LABEL_PREFIX}.worktree-id`]: target.identity.worktreeId,
    [`${LABEL_PREFIX}.worktree-path-sha256`]: target.identity.pathDigest,
  };
}

export async function startContainer(target) {
  const state = inspectContainer(target);
  if (state?.running) {
    await waitForHealthy(target);
    return "running";
  }
  await assertPortAvailable(target);
  if (state) {
    docker(["start", target.container]);
  } else {
    if (target.volume) ensureVolume(target);
    createContainer(target);
  }
  await waitForHealthy(target);
  return state ? "started" : "created";
}

function ensureVolume(target) {
  const result = docker(["volume", "inspect", target.volume], { allowFailure: true });
  if (result.status === 0) {
    assertOwnedLabels(JSON.parse(result.stdout)[0].Labels, target, `Volume ${target.volume}`);
    return;
  }
  docker(["volume", "create", ...labelArguments(target), target.volume]);
}

function labelArguments(target) {
  return Object.entries(ownershipLabels(target)).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
}

function createContainer(target) {
  const storage = target.volume
    ? ["--volume", `${target.volume}:/var/lib/postgresql`]
    : ["--rm", "--tmpfs", "/var/lib/postgresql:rw,size=1g"];
  const durability = target.volume
    ? []
    : ["-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"];
  // The image refuses to initialize without a superuser password. This one is
  // never stored; bootstrap clears it so the superuser is reachable only
  // through the container-local socket.
  const initialPassword = randomBytes(32).toString("base64url");
  docker(
    [
      "run",
      "--detach",
      "--name",
      target.container,
      ...labelArguments(target),
      "--publish",
      `127.0.0.1:${target.port}:5432`,
      "--env",
      "POSTGRES_PASSWORD",
      "--health-cmd",
      "pg_isready --host 127.0.0.1 --username postgres --dbname postgres",
      "--health-interval",
      "1s",
      "--health-timeout",
      "5s",
      "--health-retries",
      "120",
      ...storage,
      POSTGRES_IMAGE,
      ...durability,
    ],
    { env: { POSTGRES_PASSWORD: initialPassword }, secrets: [initialPassword] },
  );
}

async function assertPortAvailable(target) {
  // Engines release a removed container's port forward asynchronously.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await portAcceptsConnections(target.host, target.port))) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  const owners = docker(["ps", "--filter", `publish=${target.port}`, "--format", "{{.Names}}"], {
    allowFailure: true,
  }).stdout.trim();
  throw new DatabaseLifecycleError(
    `Port ${target.host}:${target.port} is already in use${owners ? ` by container ${owners}` : ""}. Stop that process; this worktree will not share or take over another database.`,
  );
}

function portAcceptsConnections(host, port) {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host, port: Number(port) });
    const finish = (open) => {
      socket.destroy();
      resolveProbe(open);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function waitForHealthy(target) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = inspectContainer(target);
    if (!state)
      throw new DatabaseLifecycleError(`Container ${target.container} exited during startup.`);
    if (state.health === "healthy" && (await portAcceptsConnections(target.host, target.port))) {
      return;
    }
    if (state.health === "unhealthy" || !state.running) {
      throw new DatabaseLifecycleError(
        `Container ${target.container} is ${state.running ? state.health : "stopped"}; inspect it with "docker logs ${target.container}".`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new DatabaseLifecycleError(`Timed out waiting for ${target.container} to become healthy.`);
}

/** Verifies a running, healthy, worktree-owned target before a client connects. */
export async function requireHealthyTarget(target) {
  const state = inspectContainer(target);
  if (!state?.running) {
    throw new DatabaseLifecycleError(
      `This worktree's ${target.profile} PostgreSQL is not running. Start it with "vp run db:${target.profile}:start".`,
    );
  }
  await waitForHealthy(target);
}

export function stopContainer(target) {
  const state = inspectContainer(target);
  if (!state?.running) return "not running";
  docker(["stop", target.container]);
  return "stopped";
}

/** drizzle-kit hides server errors; migration statements contain no credentials. */
export function recentServerErrors(target) {
  if (!inspectContainer(target)) return "";
  const logs = docker(["logs", "--tail", "200", target.container], { allowFailure: true });
  return redact(`${logs.stdout}${logs.stderr}`, [...target.passwords.values()])
    .split("\n")
    .filter((line) => /\b(ERROR|DETAIL|CONTEXT):/.test(line))
    .slice(-12)
    .join("\n");
}

/** Deletes this worktree's container and its data volume after verifying ownership labels. */
export function removeResources(target) {
  if (inspectContainer(target)) docker(["rm", "--force", "--volumes", target.container]);
  if (!target.volume) return;
  const volume = docker(["volume", "inspect", target.volume], { allowFailure: true });
  if (volume.status !== 0) return;
  assertOwnedLabels(JSON.parse(volume.stdout)[0].Labels, target, `Volume ${target.volume}`);
  docker(["volume", "rm", target.volume]);
}

/** Runs SQL as the container superuser over the container-local Unix socket. */
export function superuserSql(target, database, sql) {
  const secrets = [...target.passwords.values()];
  docker(
    [
      "exec",
      "--interactive",
      target.container,
      "psql",
      "--no-psqlrc",
      "--quiet",
      "--set",
      "ON_ERROR_STOP=1",
      "--set",
      "VERBOSITY=terse",
      "--username",
      "postgres",
      "--dbname",
      database,
    ],
    // Keep failed statements, which may contain role passwords, out of server logs.
    { input: `SET log_min_error_statement = panic;\n${sql}`, secrets },
  );
}

export function redact(text, secrets) {
  let result = text ?? "";
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}
