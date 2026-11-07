import { expect, test, type Page } from "@playwright/test";
import { executeLocalSql, sqlValue } from "./support/d1";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as Ada Local" }).click();
  await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
  return (await (await page.request.get("/api/auth/get-session")).json()).user;
}

test("a failed history refresh retains cached traces and offers a read-only retry", async ({
  page,
}) => {
  const user = await signIn(page);
  await page.evaluate((id) => {
    sessionStorage.setItem(
      `tracera-cache:${id}:history`,
      JSON.stringify({
        storedAt: Date.now(),
        value: [
          {
            runId: "cached-trace",
            headline: "A cached trace remains available",
            status: "running",
            score: null,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
  }, user.id);
  await page.route("**/*serverFn/*", (route) => route.abort("failed"));
  await page.reload();
  const history = page.getByRole("navigation", { name: "Your traces" });
  await expect(history.getByText("Unable to load your traces.")).toBeVisible();
  await expect(
    history.getByRole("link", { name: /A cached trace remains available/ }),
  ).toBeVisible();
  await expect(history.getByText("Traces you run are kept here.")).toHaveCount(0);
  await page.unroute("**/*serverFn/*");
  await history.getByRole("button", { name: "Retry traces" }).click();
  await expect(history.getByText("Unable to load your traces.")).toHaveCount(0);
  await expect(history.getByText("A cached trace remains available")).toHaveCount(0);
});

test("an account lookup failure does not claim sign-in methods are unlinked", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/auth/list-accounts", (route) => route.abort("failed"));
  await page.goto("/settings");
  const account = page.getByRole("region", { name: "Account", exact: true });
  await expect(account.getByText("Unable to load your sign-in methods.")).toBeVisible();
  await expect(account.getByText("Not linked to this account")).toHaveCount(0);
  await page.unroute("**/api/auth/list-accounts");
  await account.getByRole("button", { name: "Retry sign-in methods" }).click();
  await expect(account.getByText("Not linked to this account")).toHaveCount(2);
});

test("provider key metadata can retry a failed initial load", async ({ page }) => {
  await signIn(page);
  await page.route("**/*serverFn/*", (route) => route.abort("failed"));
  await page.goto("/settings");
  const keys = page.getByRole("region", { name: "AI provider" });
  await expect(keys.getByText("Unable to load your provider keys.")).toBeVisible();
  await expect(keys.getByText(/No personal keys saved/)).toHaveCount(0);
  await page.unroute("**/*serverFn/*");
  await keys.getByRole("button", { name: "Retry provider keys" }).click();
  await expect(keys.getByText(/No personal keys saved/)).toBeVisible();
});

test("confirmed key mutations remain successful when metadata refresh fails", async ({ page }) => {
  const user = await signIn(page);
  executeLocalSql(`INSERT INTO user_provider_keys(user_id,provider,model,embedding_model,ciphertext,iv,encryption_version,fingerprint,status,created_at) VALUES
    (${sqlValue(user.id)},'gemini','gemini-test-model','embedding-test-model','opaque','opaque',1,'1234','active',0),
    (${sqlValue(user.id)},'openai','openai-test-model','embedding-test-model','opaque','opaque',1,'5678','inactive',0);`);
  try {
    const metadata = page.waitForResponse(
      async (response) =>
        response.url().includes("serverFn") &&
        response.request().method() === "GET" &&
        response.request().headers()["referer"] === new URL("/settings", page.url()).href &&
        (await response.text()).includes("5678"),
    );
    await page.goto("/settings");
    const metadataUrl = (await metadata).url();
    const keys = page.getByRole("region", { name: "AI provider" });
    await expect(keys.getByRole("button", { name: "Use OpenAI key" })).toBeEnabled();
    let writes = 0;
    await page.route("**/*serverFn/*", (route) => {
      if (route.request().method() === "POST") writes += 1;
      return route.fallback();
    });
    await page.route(metadataUrl, (route) => route.abort("failed"));
    await keys
      .getByRole("button", { name: "Use OpenAI key" })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await expect(keys.getByText("New analyses will use this key.")).toBeVisible();
    expect(writes).toBe(1);
    await expect(keys.getByText("Unable to load your provider keys.")).toBeVisible();
    await expect(
      keys.getByText("Could not update your provider key. Please try again."),
    ).toHaveCount(0);
    await expect(keys.getByRole("button", { name: "Use OpenAI key" })).toBeDisabled();
    await page.unroute(metadataUrl);
    await keys.getByRole("button", { name: "Retry provider keys" }).click();
    await expect(keys.getByText("OpenAI in use", { exact: true })).toBeVisible();

    await page.route(metadataUrl, (route) => route.abort("failed"));
    await keys.getByRole("button", { name: "Remove OpenAI key" }).click();
    await expect(keys.getByText("Provider key removed.")).toBeVisible();
    expect(writes).toBe(2);
    await expect(keys.getByText("Unable to load your provider keys.")).toBeVisible();
    await page.unroute(metadataUrl);
    await keys.getByRole("button", { name: "Retry provider keys" }).click();
    await expect(keys.getByText("••••5678")).toHaveCount(0);
  } finally {
    executeLocalSql(`DELETE FROM user_provider_keys WHERE user_id=${sqlValue(user.id)};`);
  }
});

test("a late accepted trace refreshes history without leaving Settings", async ({ page }) => {
  await signIn(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let accepted!: (runId: string) => void;
  const saved = new Promise<string>((resolve) => {
    accepted = resolve;
  });
  await page.route("**/*serverFn/*", async (route) => {
    if (
      route.request().method() !== "POST" ||
      !route.request().postData()?.includes("idempotencyKey")
    ) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const runId = (await response.text()).match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/)?.[0];
    expect(runId).toBeTruthy();
    accepted(runId!);
    await pending;
    await route.fulfill({ response });
  });
  await page.getByLabel("Story or claim to analyze").fill("The library opened in 2026.");
  await expect(page.getByRole("button", { name: "Analyze", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  try {
    const runId = await saved;
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    release();
    await expect(
      page.getByRole("navigation", { name: "Your traces" }).locator(`a[href="/run/${runId}"]`),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/settings$/);
  } finally {
    release();
  }
});
