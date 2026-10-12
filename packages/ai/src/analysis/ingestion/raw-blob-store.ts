import { createHash } from "node:crypto";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { RawBlobStore } from "../storage";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const locatorPattern = /^r2:\/\/snapshots\/[a-zA-Z0-9_-]+\/[a-f0-9]{64}$/;

export function createR2RawBlobStore(bucket: Pick<R2Bucket, "get" | "put">): RawBlobStore {
  return {
    async put({ snapshotId, bytes, signal }) {
      signal.throwIfAborted();
      if (snapshotId.trim() !== snapshotId || !/^[a-zA-Z0-9_-]+$/.test(snapshotId))
        throw new Error("Invalid snapshot ID.");
      const key = `snapshots/${snapshotId}/${digest(bytes)}`;
      await bucket.put(key, bytes);
      signal.throwIfAborted();
      return { status: "stored", uri: `r2://${key}` };
    },
    async read(uri, signal) {
      signal.throwIfAborted();
      if (uri.trim() !== uri || !locatorPattern.test(uri)) return null;
      const key = uri.slice("r2://".length);
      const object = await bucket.get(key);
      signal.throwIfAborted();
      if (!object) return null;
      const bytes = new Uint8Array(await object.arrayBuffer());
      signal.throwIfAborted();
      if (digest(bytes) !== key.split("/").at(-1))
        throw new Error("Raw blob content hash mismatch.");
      return bytes;
    },
  };
}
