import { z } from "zod";

const databaseSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  read_replication: z.object({ mode: z.enum(["auto", "disabled"]) }),
});

/** Enable replicas on the configured database, then verify persisted state. */
export async function enableD1ReadReplication(
  target: {
    accountId: string;
    databaseId: string;
    databaseName: string;
    apiToken: string;
  },
  request: typeof fetch = fetch,
): Promise<void> {
  if (!target.apiToken.trim()) {
    throw new Error("CLOUDFLARE_API_TOKEN is required to enable D1 replicas");
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(target.accountId)}/d1/database/${encodeURIComponent(target.databaseId)}`;

  async function call(method: "GET" | "PUT"): Promise<unknown> {
    const response = await request(url, {
      method,
      headers: {
        Authorization: `Bearer ${target.apiToken}`,
        "Content-Type": "application/json",
      },
      ...(method === "PUT" ? { body: JSON.stringify({ read_replication: { mode: "auto" } }) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`D1 replication ${method} failed (HTTP ${response.status})`);
    }
    return z.object({ success: z.literal(true), result: z.unknown() }).parse(await response.json())
      .result;
  }

  function verifyIdentity(value: unknown): z.infer<typeof databaseSchema> {
    const database = databaseSchema.parse(value);
    if (database.uuid !== target.databaseId || database.name !== target.databaseName) {
      throw new Error("D1 replication database identity mismatch");
    }
    return database;
  }

  const current = verifyIdentity(await call("GET"));
  if (current.read_replication.mode === "auto") return;
  await call("PUT");
  const updated = verifyIdentity(await call("GET"));
  if (updated.read_replication.mode !== "auto") {
    throw new Error("D1 read replication is still disabled; deployment stopped");
  }
}
