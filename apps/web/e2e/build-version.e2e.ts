import { expect, test } from "@playwright/test";

test("public build metadata bypasses caches without requiring a session", async ({ request }) => {
  const response = await request.get("/version.json");
  expect(response.ok()).toBe(true);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(await response.json()).toEqual({ version: expect.stringMatching(/^[\w.-]{1,64}$/) });
});
