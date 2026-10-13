import { afterEach, expect, test, vi } from "vite-plus/test";
import { ProviderRequestError, requestProviderJson } from "../src/provider-request";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const secret = "secret-sentinel-must-never-escape";
const request = () =>
  requestProviderJson("Test provider", "https://provider.example/v1", {
    headers: { authorization: `Bearer ${secret}` },
  });

test("provider credentials never travel over HTTP or follow redirects", async () => {
  const transport = vi.fn(
    async () =>
      new Response(null, { status: 307, headers: { location: "http://public.example/v1" } }),
  );
  vi.stubGlobal("fetch", transport);
  await expect(
    requestProviderJson("Test provider", "http://public.example/v1", {
      headers: { authorization: secret },
    }),
  ).rejects.toBeInstanceOf(ProviderRequestError);
  expect(transport).not.toHaveBeenCalled();
  await expect(request()).rejects.toBeInstanceOf(ProviderRequestError);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0]).toHaveLength(2);
});

for (const [name, response] of [
  [
    "HTTP errors",
    () =>
      new Response(
        JSON.stringify({ error: { message: secret, headers: { authorization: secret } } }),
        { status: 401 },
      ),
  ],
  ["successful error envelopes", () => Response.json({ error: { message: secret } })],
  ["invalid JSON", () => new Response(`invalid ${secret}`)],
  ["invalid response shapes", () => Response.json([secret])],
] as const) {
  test(`provider request redacts ${name}`, async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const error = await request().catch((error) => error);
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error).not.toHaveProperty("cause");
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
}

test("provider request discards transport error details", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error(`headers: authorization=Bearer ${secret}`);
    }),
  );
  const error = await request().catch((error) => error);
  expect(error).toBeInstanceOf(ProviderRequestError);
  expect(String(error)).toBe("ProviderRequestError: Test provider request failed.");
  expect(JSON.stringify(error)).not.toContain(secret);
});

test("provider request honors cancellation with a redacted AbortError", async () => {
  const controller = new AbortController();
  controller.abort(new Error(secret));
  const error = await requestProviderJson("Test provider", "https://provider.example/", {
    signal: controller.signal,
  }).catch((error) => error);
  expect(error).toHaveProperty("name", "AbortError");
  expect(String(error)).not.toContain(secret);
});
