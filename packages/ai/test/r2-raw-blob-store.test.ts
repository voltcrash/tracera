import { createHash } from "node:crypto";
import type { R2Bucket } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createR2RawBlobStore } from "../src/analysis/ingestion";

let runtime: Miniflare;
let bucket: R2Bucket;
beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-07-30",
    r2Buckets: ["BLOBS"],
  });
  bucket = (await runtime.getR2Bucket("BLOBS")) as unknown as R2Bucket;
});
afterAll(async () => {
  await runtime?.dispose();
});

const signal = () => new AbortController().signal;

test("R2 stores and reads content-addressed snapshot bytes idempotently", async () => {
  const store = createR2RawBlobStore(bucket);
  const bytes = new TextEncoder().encode("Original evidence — immutable bytes");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const locator = await store.put({ snapshotId: "snap_original", bytes, signal: signal() });
  expect(locator).toEqual({ status: "stored", uri: `r2://snapshots/snap_original/${hash}` });
  expect(await store.put({ snapshotId: "snap_original", bytes, signal: signal() })).toEqual(
    locator,
  );
  expect(await store.read(locator.uri!, signal())).toEqual(bytes);
  expect((await bucket.list()).objects).toHaveLength(1);
});

test("R2 stores changed content under a different key", async () => {
  const store = createR2RawBlobStore(bucket);
  const first = await store.put({
    snapshotId: "snap_versions",
    bytes: new Uint8Array([1]),
    signal: signal(),
  });
  const second = await store.put({
    snapshotId: "snap_versions",
    bytes: new Uint8Array([2]),
    signal: signal(),
  });
  expect(first.uri).not.toBe(second.uri);
  expect(await store.read(first.uri!, signal())).toEqual(new Uint8Array([1]));
  expect(await store.read(second.uri!, signal())).toEqual(new Uint8Array([2]));
});
