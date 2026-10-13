import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import { decryptProviderKey, ProviderKeyRejectedError } from "@repo/ai";
import {
  listProviderKeysForUser,
  providerKeyStorage,
  saveProviderKeyForUser,
} from "../src/server/provider-keys.server";
import { createWorkerTestEnv, signIn } from "./support/worker-env";

const secret = JSON.stringify({ activeVersion: 1, keys: { 1: btoa("x".repeat(32)) } });
const input = {
  provider: "anthropic",
  apiKey: "private-generation-canary",
  model: "chosen-model",
  embeddingProvider: "openai",
  embeddingApiKey: "private-embedding-canary",
  embeddingModel: "chosen-embedding",
};
let harness: Awaited<ReturnType<typeof createWorkerTestEnv>>;
let owner: string;
let other: string;
beforeAll(async () => {
  harness = await createWorkerTestEnv({ PROVIDER_KEYS_ENCRYPTION_KEY: secret });
  owner = (await signIn(harness.env, "ada")).user.id;
  other = (await signIn(harness.env, "grace")).user.id;
});
afterAll(async () => {
  await harness?.dispose();
});

test("verified keys are stored encrypted and only their owner's metadata can be listed", async () => {
  const verify = vi.fn(async () => undefined);
  expect(await saveProviderKeyForUser(harness.env, owner, input, verify)).toEqual({ ok: true });
  expect(verify).toHaveBeenCalledOnce();
  const listed = await listProviderKeysForUser(harness.env, owner);
  expect(listed).toMatchObject({
    available: true,
    keys: [{ provider: "anthropic", fingerprint: "nary", status: "active" }],
  });
  expect(JSON.stringify(listed)).not.toContain("private-generation");
  expect(listed.keys[0]).not.toHaveProperty("ciphertext");
  expect(await listProviderKeysForUser(harness.env, other)).toEqual({ available: true, keys: [] });
  const record = (await providerKeyStorage(harness.env).activeRecord(owner))!;
  expect(JSON.stringify(record)).not.toContain(input.apiKey);
  expect(
    await decryptProviderKey({
      secret,
      userId: owner,
      provider: record.provider,
      encrypted: record,
    }),
  ).toEqual({ apiKey: input.apiKey, embeddingApiKey: input.embeddingApiKey });
});

test("a failed verification preserves the stored key and never exposes upstream credentials", async () => {
  const before = await providerKeyStorage(harness.env).activeRecord(owner);
  const rejected = await saveProviderKeyForUser(
    harness.env,
    owner,
    { ...input, apiKey: "replacement-secret" },
    async () => {
      throw new ProviderKeyRejectedError();
    },
  );
  expect(rejected).toMatchObject({
    ok: false,
    error: expect.stringContaining("Your key was rejected"),
  });
  expect(await providerKeyStorage(harness.env).activeRecord(owner)).toEqual(before);
  const transport = await saveProviderKeyForUser(harness.env, owner, input, async () => {
    throw new Error(input.apiKey);
  });
  expect(JSON.stringify(transport)).not.toContain(input.apiKey);
});

test("missing encryption configuration and invalid input stop before provider verification", async () => {
  const verify = vi.fn(async () => undefined);
  const unconfigured = { ...harness.env, PROVIDER_KEYS_ENCRYPTION_KEY: undefined };
  expect((await listProviderKeysForUser(unconfigured, owner)).available).toBe(false);
  expect(await saveProviderKeyForUser(unconfigured, owner, input, verify)).toMatchObject({
    ok: false,
  });
  expect(
    await saveProviderKeyForUser(harness.env, owner, { ...input, userId: other }, verify),
  ).toMatchObject({ ok: false });
  expect(verify).not.toHaveBeenCalled();
});
