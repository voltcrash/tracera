import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { D1PayloadStore, MAX_D1_PAYLOAD_BYTES, hashJson } from "../../src/d1/payloads.js";
import { createTestRuntime } from "./runtime.js";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
beforeAll(async () => {
  runtime = await createTestRuntime();
});
afterAll(async () => {
  await runtime?.dispose();
});

test("small JSON payloads stay inline with canonical equality hashes", async () => {
  const store = new D1PayloadStore(runtime.bucket);
  const value = { z: "value", a: [1, 2] };
  const pointer = await store.encode(value, "checkpoints");
  expect(pointer.blobUri).toBeNull();
  expect(pointer.hash).toBe(hashJson({ a: [1, 2], z: "value" }));
  expect(await store.read(pointer)).toEqual(value);
});

test("large UTF-8 payloads are offloaded to R2 and round-trip without data loss", async () => {
  const store = new D1PayloadStore(runtime.bucket);
  const value = { text: "測".repeat(MAX_D1_PAYLOAD_BYTES / 3) };
  const pointer = await store.encode(value, "snapshots");
  expect(pointer.inline).toBeNull();
  expect(pointer.blobUri).toMatch(/^r2:\/\/payloads\/snapshots\/[a-f0-9]{64}$/);
  expect(await store.read(pointer)).toEqual(value);
  expect(await store.encode(value, "snapshots")).toEqual(pointer);
});

test("R2 offload accounts for duplicate inline projection bytes", async () => {
  const pointer = await new D1PayloadStore(runtime.bucket).encode(
    { text: "x" },
    "snapshots",
    MAX_D1_PAYLOAD_BYTES,
  );
  expect(pointer.inline).toBeNull();
});

test("payload reads reject missing objects, malformed pointers and altered bytes", async () => {
  const store = new D1PayloadStore(runtime.bucket);
  await expect(store.read({ inline: null, blobUri: "file:///tmp/private" })).rejects.toThrow(
    /pointer/,
  );
  await expect(
    store.read({ inline: null, blobUri: `r2://payloads/reports/${"0".repeat(64)}` }),
  ).rejects.toThrow(/unavailable/);
  await expect(
    store.read({ inline: "{}", blobUri: null, hash: hashJson({ changed: true }) }),
  ).rejects.toThrow(/hash mismatch/);
  const pointer = await store.encode({ text: "x".repeat(MAX_D1_PAYLOAD_BYTES) }, "reports");
  await runtime.bucket.put(pointer.blobUri!.slice(5), "changed");
  await expect(store.read(pointer)).rejects.toThrow(/hash mismatch/);
});

test("large payloads fail before a D1 write when R2 is unavailable", async () => {
  await expect(
    new D1PayloadStore().encode({ text: "x".repeat(MAX_D1_PAYLOAD_BYTES) }, "reports"),
  ).rejects.toThrow(/R2 binding/);
});

test("large and heavily escaped projections use a hash-checked R2 pointer", async () => {
  const store = new D1PayloadStore(runtime.bucket);
  const value = { text: '"'.repeat(500_000) };
  const encoded = await store.encodeProjection(value);
  const pointer = JSON.parse(encoded);
  expect(pointer.r2Payload.uri).toMatch(/^r2:\/\/payloads\/reports\//);
  expect(await store.readProjection(pointer)).toEqual(value);
  const small = { text: "small" };
  expect(await store.readProjection(JSON.parse(await store.encodeProjection(small)))).toEqual(
    small,
  );
});
