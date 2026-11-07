import { createHash } from "node:crypto";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { RawBlobStore } from "../storage";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const locatorPattern =
  /^r2:\/\/(uploads\/)?snapshots\/[a-zA-Z0-9_-]+\/([a-f0-9]{64})(?:\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}))?$/;

export function createR2RawBlobStore(bucket: Pick<R2Bucket, "get" | "put">): RawBlobStore {
  return {
    async put({ snapshotId, bytes, signal }) {
      signal.throwIfAborted();
      if (snapshotId.trim() !== snapshotId || !/^[a-zA-Z0-9_-]+$/.test(snapshotId))
        throw new Error("Invalid snapshot ID.");
      const key = `uploads/snapshots/${snapshotId}/${digest(bytes)}/${crypto.randomUUID()}`;
      await bucket.put(key, bytes);
      signal.throwIfAborted();
      return { status: "stored", uri: `r2://${key}` };
    },
    async read(uri, signal) {
      signal.throwIfAborted();
      const match = uri.match(locatorPattern);
      if (uri.trim() !== uri || !match || Boolean(match[1]) !== Boolean(match[3])) return null;
      const key = uri.slice("r2://".length);
      const object = await bucket.get(key);
      signal.throwIfAborted();
      if (!object) return null;
      const bytes = new Uint8Array(await object.arrayBuffer());
      signal.throwIfAborted();
      if (digest(bytes) !== match[2]) throw new Error("Raw blob content hash mismatch.");
      return bytes;
    },
  };
}
