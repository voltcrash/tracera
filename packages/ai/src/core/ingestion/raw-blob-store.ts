import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RawBlobStore } from "../storage";

const abort = (signal: AbortSignal) => signal.throwIfAborted();

export function createFilesystemRawBlobStore(rootDirectory: string): RawBlobStore {
  const root = resolve(rootDirectory);
  return {
    async put({ snapshotId, bytes, signal }) {
      abort(signal);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const digest = createHash("sha256").update(bytes).digest("hex");
      const filename = `${safeName(snapshotId)}-${digest}.blob`;
      const path = join(root, filename);
      try {
        await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error("An immutable raw-blob path is not a regular file.");
        }
        const existing = await readFile(path);
        if (!existing.equals(Buffer.from(bytes))) {
          throw new Error("An immutable raw-blob path already contains different bytes.");
        }
      }
      abort(signal);
      return { status: "stored", uri: pathToFileURL(path).href };
    },
    async read(uri, signal) {
      abort(signal);
      let path: string;
      try {
        const parsed = new URL(uri);
        if (parsed.protocol !== "file:") return null;
        path = resolve(fileURLToPath(parsed));
      } catch {
        return null;
      }
      if (!path.startsWith(`${root}${sep}`) || basename(path) !== path.slice(root.length + 1)) {
        return null;
      }
      try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
        const bytes = await readFile(path);
        abort(signal);
        return bytes;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
  };
}

function safeName(value: string) {
  const name = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return name || "snapshot";
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
