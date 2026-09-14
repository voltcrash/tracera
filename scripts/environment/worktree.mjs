import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const rootDirectory = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function worktreeIdentity(directory = rootDirectory) {
  const worktreePath = realpathSync(directory);
  const digest = createHash("sha256").update(worktreePath).digest("hex");
  const readableName = basename(worktreePath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 20);
  const localPort = 20_000 + (Number.parseInt(digest.slice(0, 6), 16) % 20_000);
  const webPort = 40_000 + (Number.parseInt(digest.slice(6, 12), 16) % 20_000);
  return {
    worktreeId: `${readableName}_${digest.slice(0, 8)}`,
    pathDigest: digest,
    ports: { local: String(localPort), test: String(localPort + 1), web: String(webPort) },
  };
}
