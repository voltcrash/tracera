import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createD1ProviderKeyRepository } from "../../src/provider-keys.js";
import { createTestRuntime, seedUser } from "./runtime.js";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
let keys: ReturnType<typeof createD1ProviderKeyRepository>;
const savedKey = {
  provider: "openai" as const,
  model: "model-a",
  embeddingModel: "embedding-a",
  baseUrl: null,
  embeddingProvider: null,
  embeddingBaseUrl: null,
  ciphertext: "encrypted-value",
  iv: "random-iv",
  encryptionVersion: 1,
  fingerprint: "abcd",
};
beforeAll(async () => {
  runtime = await createTestRuntime();
  keys = createD1ProviderKeyRepository(runtime.db);
  await seedUser(runtime.db, "key-owner");
  await seedUser(runtime.db, "other-owner");
});
afterAll(async () => {
  await runtime?.dispose();
});

test("metadata excludes ciphertext and IV and every operation stays inside the owner's scope", async () => {
  await keys.save("key-owner", savedKey);
  expect(await keys.activeRecord("other-owner")).toBeNull();
  expect(await keys.list("other-owner")).toEqual([]);
  const metadata = (await keys.list("key-owner"))[0]!;
  expect(metadata).toMatchObject({ provider: "openai", status: "active", fingerprint: "abcd" });
  expect(metadata).not.toHaveProperty("ciphertext");
  expect(metadata).not.toHaveProperty("iv");
  expect(metadata).not.toHaveProperty("encryptionVersion");
  await keys.delete("other-owner", "openai");
  expect(await keys.activate("other-owner", "openai")).toBe(false);
  expect(await keys.activeMetadata("key-owner")).not.toBeNull();
});

test("concurrent saves keep exactly one active key and missing activation preserves it", async () => {
  await Promise.all([
    keys.save("key-owner", savedKey),
    keys.save("key-owner", { ...savedKey, provider: "gemini" }),
  ]);
  expect((await keys.list("key-owner")).filter((key) => key.status === "active")).toHaveLength(1);
  await keys.activate("key-owner", "openai");
  expect(await keys.activate("key-owner", "anthropic")).toBe(false);
  expect((await keys.activeMetadata("key-owner"))?.provider).toBe("openai");
});

test("usage timestamps apply only to the current ciphertext and replacement clears usage", async () => {
  await keys.markUsed("other-owner", "openai", savedKey.ciphertext);
  await keys.markUsed("key-owner", "openai", "stale-ciphertext");
  expect((await keys.activeMetadata("key-owner"))?.lastUsedAt).toBeNull();
  await keys.markUsed("key-owner", "openai", savedKey.ciphertext);
  expect((await keys.activeMetadata("key-owner"))?.lastUsedAt).toBeInstanceOf(Date);
  await keys.save("key-owner", { ...savedKey, ciphertext: "replacement" });
  expect((await keys.activeMetadata("key-owner"))?.lastUsedAt).toBeNull();
});

test("constraints reject duplicate active keys and invalid versions; deleting a user deletes their keys", async () => {
  await expect(
    runtime.db
      .prepare("UPDATE user_provider_keys SET status='active' WHERE user_id='key-owner'")
      .run(),
  ).rejects.toThrow();
  await expect(
    runtime.db
      .prepare("UPDATE user_provider_keys SET encryption_version=0 WHERE user_id='key-owner'")
      .run(),
  ).rejects.toThrow();
  await runtime.db.prepare("DELETE FROM users WHERE id='key-owner'").run();
  expect(await keys.list("key-owner")).toEqual([]);
});
