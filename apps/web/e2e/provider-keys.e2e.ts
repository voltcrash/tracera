import { expect, test } from "@playwright/test";
import { executeLocalSql, sqlValue } from "./support/d1";

test.afterEach(() => {
  executeLocalSql(
    "DELETE FROM user_provider_keys WHERE user_id IN (SELECT id FROM users WHERE email='ada@tracera.local');",
  );
});

test("personal key settings stay private across switching, reload, removal and another account", async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as Ada Local" }).click();
  await expect(page).toHaveURL(/\/home$/);
  const { user } = (await (await page.request.get("/api/auth/get-session")).json()) as {
    user: { id: string };
  };
  executeLocalSql(`DELETE FROM user_provider_keys WHERE user_id=${sqlValue(user.id)};
    INSERT INTO user_provider_keys(user_id,provider,model,embedding_model,ciphertext,iv,encryption_version,fingerprint,status,created_at) VALUES
    (${sqlValue(user.id)},'gemini','gemini-test-model','embedding-test-model','opaque-ciphertext-canary','opaque-iv',1,'1234','active',0),
    (${sqlValue(user.id)},'openai','openai-test-model','embedding-test-model','opaque-ciphertext-canary','opaque-iv',1,'5678','inactive',0);`);
  const metadataResponse = page.waitForResponse(
    async (response) =>
      response.url().includes("serverFn") &&
      response.request().method() === "GET" &&
      (await response.text()).includes("1234"),
  );
  await page.goto("/settings");
  const metadata = await metadataResponse;
  expect(metadata.headers()["cache-control"]).toBe("private, no-store");
  expect(await metadata.text()).not.toContain("opaque-ciphertext-canary");
  expect(await metadata.text()).not.toContain("opaque-iv");
  const keys = page.getByRole("region", { name: "AI provider" });
  await expect(keys.getByText("Gemini in use", { exact: true })).toBeVisible();
  await expect(keys.getByText("••••1234")).toBeVisible();
  await expect(keys.getByText("••••5678")).toBeVisible();
  await expect(keys.getByLabel("Provider API key")).toHaveAttribute("type", "password");
  await expect(keys.getByLabel("Provider API key")).toHaveValue("");

  const anonymous = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const response = await anonymous.request.get(metadata.url(), { maxRedirects: 0 });
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(await response.text()).not.toContain("5678");
    const unauthenticated = await anonymous.request.get(metadata.url(), {
      maxRedirects: 0,
      headers: { "x-tsr-serverfn": "true" },
    });
    expect(unauthenticated.headers()["cache-control"]).toBe("private, no-store");
    expect(await unauthenticated.text()).not.toContain("5678");
    const other = await anonymous.newPage();
    await other.goto("/");
    await other.getByRole("button", { name: "Continue as Grace Local" }).click();
    await expect(other).toHaveURL(/\/home$/);
    await other.goto("/settings");
    await expect(other.getByText(/No personal keys saved/)).toBeVisible();
    await expect(other.getByText("••••1234")).toHaveCount(0);
  } finally {
    await anonymous.close();
  }

  const switching = page.waitForResponse(
    (response) => response.url().includes("serverFn") && response.request().method() === "POST",
  );
  await keys.getByRole("button", { name: "Use OpenAI key" }).click();
  expect((await switching).headers()["cache-control"]).toBe("private, no-store");
  await expect(keys.getByText("OpenAI in use", { exact: true })).toBeVisible();
  await page.reload();
  await expect(keys.getByText("OpenAI in use", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect
    .poll(() =>
      keys.locator("input, select, button").evaluateAll((elements) =>
        elements.every((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth;
        }),
      ),
    )
    .toBe(true);
  await keys.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("personal-provider-settings-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({
    path: testInfo.outputPath("personal-provider-settings-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await keys.getByRole("button", { name: "Remove OpenAI key" }).click();
  await expect(keys.getByText("••••5678")).toHaveCount(0);
  await keys.getByRole("button", { name: "Use Gemini key" }).click();
  await expect(keys.getByText("Gemini in use", { exact: true })).toBeVisible();
  await keys.getByRole("button", { name: "Remove Gemini key" }).click();
  await expect(keys.getByText(/No personal keys saved/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("key entry supports separate embeddings and rejects insecure endpoints without storing secrets", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as Ada Local" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await page.goto("/settings");
  const keys = page.getByRole("region", { name: "AI provider" });
  await keys.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  await expect(keys.getByLabel("Embedding API key")).toBeVisible();
  await keys.getByLabel("Provider", { exact: true }).selectOption("openai-compatible");
  await keys.getByLabel("Provider API key").fill("browser-entry-secret-canary");
  await keys.getByLabel("HTTPS base URL", { exact: true }).fill("http://127.0.0.1/v1");
  await keys.getByLabel("Generation model").fill("test-model");
  await keys.getByLabel("Embedding model").fill("test-embedding");
  await keys.getByRole("button", { name: "Verify and save key" }).click();
  await expect(keys.getByRole("alert")).toContainText("Could not save your provider key");
  await expect(keys.getByRole("button", { name: "Verify and save key" })).toBeEnabled();
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
      }),
    ),
  ).not.toContain("browser-entry-secret-canary");
  await page.reload();
  await expect(keys.getByLabel("Provider API key")).toHaveValue("");
  await expect(keys.getByText(/No personal keys saved/)).toBeVisible();
});
