import { fileURLToPath } from "node:url";
import { bundleTestWorker } from "@repo/ai/test-bundler";
import { createTestRuntime, Response, seedUser, type Request } from "@repo/db/test-runtime";
import { expect, test } from "vite-plus/test";

const source = `
import { WorkflowEntrypoint } from "cloudflare:workers";
import { parseServerEnv } from "../../src/server/env";
import { listProviderKeysForUser, saveProviderKeyForUser } from "../../src/server/provider-keys.server";
import { resolveWorkflowProvider } from "../../src/server/provider-selection.server";
import { runContextExample } from "@repo/contracts/analysis";
export class TestWorkflow extends WorkflowEntrypoint { async run() { return {}; } }
export default { async fetch(request, bindings) {
  const env = parseServerEnv(bindings);
  const userId = new URL(request.url).searchParams.get("user") ?? "owner";
  if (request.method === "POST") return Response.json(await saveProviderKeyForUser(env, userId, await request.json()));
  if (new URL(request.url).pathname === "/resolve") {
    const context = { ...runContextExample, ownerUserId: userId, provider: { source: "user", provider: "openai" }, versions: { ...runContextExample.versions, model: "chosen-model", embedding: { ...runContextExample.versions.embedding, model: "chosen-embedding" } } };
    const resolved = await resolveWorkflowProvider(env, context);
    return Response.json({ source: resolved.source, correctKey: resolved.config.apiKey === "personal-workerd-canary", model: resolved.config.model });
  }
  return Response.json(await listProviderKeysForUser(env, userId));
} };`;

test("workerd verifies, encrypts, lists metadata and decrypts personal keys with its native Web Crypto", async () => {
  const calls: string[] = [];
  let rejected = false;
  const harness = await createTestRuntime({
    script: await bundleTestWorker(source, fileURLToPath(new URL("./support/", import.meta.url))),
    bindings: {
      MODE: "dev",
      ANALYSIS_MODE: "live",
      BETTER_AUTH_SECRET: "workerd-auth-secret-at-least-32-characters",
      PROVIDER_KEYS_ENCRYPTION_KEY: JSON.stringify({
        activeVersion: 1,
        keys: { 1: btoa("x".repeat(32)) },
      }),
    },
    workflows: { ANALYSIS_WORKFLOW: { name: "key-test", className: "TestWorkflow" } },
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname === "cloudflare-dns.com" || url.hostname === "1.1.1.1") {
        const ipv6 = ["AAAA", "28"].includes(url.searchParams.get("type") ?? "");
        return Response.json({
          Status: 0,
          Question: [{ name: url.searchParams.get("name"), type: ipv6 ? 28 : 1 }],
          Answer: [
            {
              name: url.searchParams.get("name"),
              type: ipv6 ? 28 : 1,
              data: ipv6 ? "2001:4860:4860::8888" : "8.8.8.8",
              TTL: 60,
            },
          ],
        });
      }
      calls.push(request.url);
      expect(request.headers.get("authorization")).toBe("Bearer personal-workerd-canary");
      if (rejected)
        return Response.json({ error: { message: "personal-workerd-canary" } }, { status: 403 });
      return Response.json(
        url.pathname.endsWith("/embeddings")
          ? { data: [{ embedding: Array(1024).fill(0.1) }] }
          : { choices: [{ message: { content: "OK" } }] },
      );
    },
  });
  try {
    await seedUser(harness.db, "owner");
    await seedUser(harness.db, "other");
    const input = {
      provider: "openai",
      apiKey: "personal-workerd-canary",
      model: "chosen-model",
      embeddingModel: "chosen-embedding",
    };
    const save = () =>
      harness.runtime.dispatchFetch("http://worker/save", {
        method: "POST",
        body: JSON.stringify(input),
      });
    expect(await (await save()).json(), JSON.stringify(calls)).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    const metadata = await (await harness.runtime.dispatchFetch("http://worker/list")).json();
    expect(metadata).toMatchObject({
      available: true,
      keys: [{ provider: "openai", fingerprint: "nary" }],
    });
    expect(JSON.stringify(metadata)).not.toContain("personal-workerd-canary");
    expect(JSON.stringify(metadata)).not.toContain("ciphertext");
    expect(
      await (await harness.runtime.dispatchFetch("http://worker/list?user=other")).json(),
    ).toEqual({ available: true, keys: [] });
    const ciphertext = await harness.db
      .prepare("SELECT ciphertext FROM user_provider_keys")
      .first<string>("ciphertext");
    expect(ciphertext).not.toContain("personal-workerd-canary");
    expect(await (await harness.runtime.dispatchFetch("http://worker/resolve")).json()).toEqual({
      source: "user",
      correctKey: true,
      model: "chosen-model",
    });
    rejected = true;
    expect(await (await save()).json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("Your key was rejected"),
    });
    expect(
      await harness.db.prepare("SELECT ciphertext FROM user_provider_keys").first("ciphertext"),
    ).toBe(ciphertext);
  } finally {
    await harness.dispose();
  }
});
