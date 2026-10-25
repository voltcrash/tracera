import { describe, expect, it, vi } from "vite-plus/test";
import { enableD1ReadReplication } from "../scripts/d1-read-replication";

const target = {
  accountId: "account-fixture",
  databaseId: "database-fixture",
  databaseName: "tracera-production",
  apiToken: "token-fixture",
};

function result(mode: "auto" | "disabled"): Response {
  return Response.json({
    success: true,
    result: {
      uuid: target.databaseId,
      name: target.databaseName,
      read_replication: { mode },
    },
  });
}

describe("D1 replication activation", () => {
  it("enables the configured database and verifies persisted state", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(result("disabled"))
      .mockResolvedValueOnce(result("auto"))
      .mockResolvedValueOnce(result("auto"));
    await enableD1ReadReplication(target, request);
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "PUT", "GET"]);
    expect(request.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ read_replication: { mode: "auto" } }),
    );
    for (const [url, init] of request.mock.calls) {
      expect(url).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/d1/database/${target.databaseId}`,
      );
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer token-fixture",
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("does not update a database that already has replicas", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(result("auto"));
    await enableD1ReadReplication(target, request);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("rejects identity mismatches before changing settings", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(result("disabled"));
    await expect(
      enableD1ReadReplication({ ...target, databaseName: "another-database" }, request),
    ).rejects.toThrow("identity mismatch");
    expect(request).toHaveBeenCalledOnce();
  });

  it("stops deployment if enabling did not persist", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => result("disabled"));
    await expect(enableD1ReadReplication(target, request)).rejects.toThrow("still disabled");
  });

  it.each([0, 1, 2])("stops on HTTP failure at step %s", async (step) => {
    const request = vi.fn<typeof fetch>();
    for (let i = 0; i < step; i++) {
      request.mockResolvedValueOnce(result("disabled"));
    }
    request.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(enableD1ReadReplication(target, request)).rejects.toThrow("HTTP 403");
    expect(request).toHaveBeenCalledTimes(step + 1);
  });

  it.each([
    { success: false, result: {} },
    { success: true },
    {
      success: true,
      result: { uuid: target.databaseId, name: target.databaseName },
    },
  ])("rejects failed or incomplete API responses (%j)", async (body) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    await expect(enableD1ReadReplication(target, request)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });

  it("requires credentials before contacting Cloudflare", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(enableD1ReadReplication({ ...target, apiToken: " " }, request)).rejects.toThrow(
      "CLOUDFLARE_API_TOKEN is required",
    );
    expect(request).not.toHaveBeenCalled();
  });
});
