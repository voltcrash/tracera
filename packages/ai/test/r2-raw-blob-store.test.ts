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

test("R2 rejects foreign, malformed and traversing locators without reading objects", async () => {
  let reads = 0;
  const store = createR2RawBlobStore({
    put: bucket.put.bind(bucket),
    get: (() => {
      reads += 1;
      throw new Error("unexpected object read");
    }) as R2Bucket["get"],
  });
  for (const uri of [
    "file:///etc/passwd",
    "https://example.com/file",
    "r2://other/snap/hash",
    `r2://snapshots/../${"a".repeat(64)}`,
    `r2://snapshots/snap/${"a".repeat(64)}?secret=1`,
    `r2://snapshots/snap/${"a".repeat(64)}\n`,
    "r2://snapshots/snap/not-a-hash",
  ])
    expect(await store.read(uri, signal())).toBeNull();
  expect(reads).toBe(0);
  expect(
    await createR2RawBlobStore(bucket).read(`r2://snapshots/missing/${"0".repeat(64)}`, signal()),
  ).toBeNull();
});

test("R2 rejects invalid snapshot IDs and tampered content", async () => {
  const store = createR2RawBlobStore(bucket);
  for (const snapshotId of ["", "../escape", "snap/id", "snap?query", "snap\n"]) {
    await expect(
      store.put({ snapshotId, bytes: new Uint8Array([1]), signal: signal() }),
    ).rejects.toThrow("Invalid snapshot ID");
  }
  const locator = await store.put({
    snapshotId: "snap_tampered",
    bytes: new Uint8Array([1]),
    signal: signal(),
  });
  await bucket.put(locator.uri!.slice(5), new Uint8Array([2]));
  await expect(store.read(locator.uri!, signal())).rejects.toThrow("content hash mismatch");
});

test("R2 checks cancellation before starting and after completing storage operations", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stopped"));
  const store = createR2RawBlobStore(bucket);
  await expect(
    store.put({ snapshotId: "snap_abort", bytes: new Uint8Array(), signal: controller.signal }),
  ).rejects.toThrow("stopped");
  await expect(store.read("r2://snapshots/snap/hash", controller.signal)).rejects.toThrow(
    "stopped",
  );
  const duringWrite = new AbortController();
  const abortingStore = createR2RawBlobStore({
    get: bucket.get.bind(bucket),
    put: (async (...args: Parameters<R2Bucket["put"]>) => {
      const object = await bucket.put(...args);
      duringWrite.abort(new Error("stopped during write"));
      return object;
    }) as R2Bucket["put"],
  });
  await expect(
    abortingStore.put({
      snapshotId: "snap_abort",
      bytes: new Uint8Array(),
      signal: duringWrite.signal,
    }),
  ).rejects.toThrow("stopped during write");
});
