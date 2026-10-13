import { expect, test } from "vite-plus/test";
import {
  decryptProviderKey,
  encryptProviderKey,
  validateProviderKeyEncryption,
  validateProviderKeyEncryptionConfiguration,
} from "../src/provider-key-crypto";

const oldKey = btoa("a".repeat(32));
const newKey = btoa("b".repeat(32));
const secret = JSON.stringify({ activeVersion: 1, keys: { 1: oldKey } });
const identity = { userId: "user-1", provider: "openai" };
const credentials = { apiKey: "private-generation-key", embeddingApiKey: "private-embedding-key" };

test("every retained encryption version is valid before activation", () => {
  expect(() => validateProviderKeyEncryptionConfiguration(secret)).not.toThrow();
  for (const ring of [
    { activeVersion: 2, keys: { 1: oldKey } },
    { activeVersion: 1, keys: { 1: oldKey, 2: "invalid-retained-key" } },
    { activeVersion: 1, keys: { 1: oldKey, "invalid-version": newKey } },
  ])
    expect(() => validateProviderKeyEncryptionConfiguration(JSON.stringify(ring))).toThrow(
      "encryption is unavailable",
    );
});

test("AES-GCM stores both keys with a fresh IV and authenticates their owner and provider", async () => {
  const encrypted = await encryptProviderKey({ secret, ...identity, credentials });
  const second = await encryptProviderKey({ secret, ...identity, credentials });
  expect(encrypted.iv).not.toBe(second.iv);
  expect(atob(encrypted.iv)).toHaveLength(12);
  expect(JSON.stringify(encrypted)).not.toContain(credentials.apiKey);
  expect(await decryptProviderKey({ secret, ...identity, encrypted })).toEqual(credentials);
  for (const changed of [{ userId: "user-2" }, { provider: "gemini" }])
    await expect(
      decryptProviderKey({ secret, ...identity, ...changed, encrypted }),
    ).rejects.toThrow("encryption is unavailable");
  await expect(
    decryptProviderKey({
      secret,
      ...identity,
      encrypted: { ...encrypted, ciphertext: btoa("tampered") },
    }),
  ).rejects.toThrow("encryption is unavailable");
});

test("rotation encrypts new keys with the active version and reads retained old versions", async () => {
  const encrypted = await encryptProviderKey({ secret, ...identity, credentials });
  const rotated = JSON.stringify({ activeVersion: 2, keys: { 1: oldKey, 2: newKey } });
  expect(await decryptProviderKey({ secret: rotated, ...identity, encrypted })).toEqual(
    credentials,
  );
  expect(
    (await encryptProviderKey({ secret: rotated, ...identity, credentials })).encryptionVersion,
  ).toBe(2);
  await expect(
    decryptProviderKey({
      secret: JSON.stringify({ activeVersion: 2, keys: { 2: newKey } }),
      ...identity,
      encrypted,
    }),
  ).rejects.toThrow("encryption is unavailable");
});

test.each([
  undefined,
  "private-secret",
  "{}",
  JSON.stringify({ activeVersion: 1, keys: { 1: btoa("short") } }),
])("invalid encryption configuration never includes secret values in errors", async (value) => {
  await expect(validateProviderKeyEncryption(value)).rejects.toThrow(
    "Provider key encryption is unavailable. Please contact the site owner.",
  );
});
