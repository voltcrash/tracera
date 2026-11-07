import { expect, test, type Page } from "@playwright/test";
import { seedBrowserRun } from "./support/reports";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as Ada Local" }).click();
  await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
  return (await (await page.request.get("/api/auth/get-session")).json()).user;
}

test("an unavailable session stays recoverable instead of navigating as anonymous", async ({
  page,
}) => {
  await signIn(page);
  let unavailable = true;
  await page.route("**/api/auth/get-session**", async (route) => {
    if (unavailable)
      await route.fulfill({ status: 503, json: { message: "Session temporarily unavailable" } });
    else await route.continue();
  });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Unable to check your session" })).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  unavailable = false;
  await page.getByRole("button", { name: "Retry session" }).click();
  await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toBeEnabled();
  await expect(page).toHaveURL(/\/settings$/);
});

test("avatar saves reject synchronous duplicates and recover from a failed request", async ({
  page,
}) => {
  const before = await signIn(page);
  await page.goto("/settings");
  const shuffle = page.getByRole("button", { name: "Shuffle to a different mark" });
  await expect(shuffle).toBeEnabled();
  let requests = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/auth/update-user", async (route) => {
    requests += 1;
    await pending;
    await route.fulfill({ status: 503, json: { message: "Avatar save failed." } });
  });
  await shuffle.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  try {
    await expect(shuffle).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByText("Avatar save failed.")).toBeVisible();
  await expect(shuffle).toBeEnabled();
  expect(requests).toBe(1);
  await page.unroute("**/api/auth/update-user");
  await shuffle.click();
  await expect(shuffle).toBeEnabled();
  expect((await (await page.request.get("/api/auth/get-session")).json()).user.image).not.toBe(
    before.image,
  );
});

test("a saved name survives a session refresh failure and subsequent retry", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings");
  const field = page.getByRole("textbox", { name: "Display name", exact: true });
  await expect(field).toBeEnabled();
  let failRefresh = false;
  await page.route("**/api/auth/update-user", async (route) => {
    const response = await route.fetch();
    failRefresh = true;
    await route.fulfill({ response });
  });
  await page.route("**/api/auth/get-session**", async (route) => {
    if (failRefresh) await route.fulfill({ status: 503, json: { message: "Refresh unavailable" } });
    else await route.continue();
  });
  await field.fill("Ada verified profile");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Unable to check your session" })).toBeVisible();
  expect((await (await page.request.get("/api/auth/get-session")).json()).user.name).toBe(
    "Ada verified profile",
  );
  failRefresh = false;
  await page.getByRole("button", { name: "Retry session" }).click();
  await expect(field).toHaveValue("Ada verified profile");
});

test("switching accounts discards another owner's optimistic name and late response", async ({
  page,
  context,
}) => {
  await signIn(page);
  await page.goto("/settings");
  const field = page.getByRole("textbox", { name: "Display name", exact: true });
  await expect(field).toBeEnabled();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/auth/update-user", async (route) => {
    await pending;
    await route.abort("failed");
  });
  await field.fill("Private Ada draft");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(field).toBeDisabled();
  const other = await context.newPage();
  try {
    await other.goto("/api/auth/dev-login?identity=grace");
    const grace = (await (await other.request.get("/api/auth/get-session")).json()).user;
    await other.evaluate(() =>
      localStorage.setItem(
        "better-auth.message",
        JSON.stringify({
          event: "session",
          data: { trigger: "signIn" },
          clientId: "profile-browser-test",
        }),
      ),
    );
    await expect(page.getByText(grace.email, { exact: true }).first()).toBeVisible();
    await expect(field).toHaveValue(grace.name);
    release();
    await expect(field).toHaveValue(grace.name);
    await expect(page.locator("body")).not.toContainText("Private Ada draft");
  } finally {
    release();
    await other.close();
  }
});

test("switching accounts discards a completed report cached for the prior owner", async ({
  page,
  context,
}) => {
  const ada = await signIn(page);
  const { runId } = seedBrowserRun(ada.id, "complete");
  await page.goto(`/run/${runId}`);
  await expect(page.getByRole("heading", { name: "Claims in this report" })).toBeVisible();
  const reloaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/run/${runId}` &&
      response.request().isNavigationRequest(),
  );
  const other = await context.newPage();
  try {
    await other.goto("/api/auth/dev-login?identity=grace");
    await other.evaluate(() =>
      localStorage.setItem(
        "better-auth.message",
        JSON.stringify({
          event: "session",
          data: { trigger: "signIn" },
          clientId: "report-browser-test",
        }),
      ),
    );
    expect((await reloaded).status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Claims in this report" })).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test("a failed sign-out remains recoverable and a retry ends the session", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/auth/sign-out", (route) =>
    route.fulfill({ status: 503, json: { message: "Unavailable" } }),
  );
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page.getByText("Unable to sign out. Please try again.")).toBeVisible();
  expect((await (await page.request.get("/api/auth/get-session")).json()).user).toBeTruthy();
  await page.unroute("**/api/auth/sign-out");
  await page.route("**/api/auth/get-session**", (route) =>
    route.fulfill({ status: 503, json: { message: "Refresh unavailable after sign-out" } }),
  );
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(await (await page.request.get("/api/auth/get-session")).json()).toBeNull();
});

test("sign-out recovers when the browser remembers a session already revoked on the server", async ({
  page,
}) => {
  await signIn(page);
  expect(
    (
      await page.request.post("/api/auth/sign-out", {
        data: {},
        headers: { origin: new URL(page.url()).origin },
      })
    ).status(),
  ).toBe(200);
  expect(await (await page.request.get("/api/auth/get-session")).json()).toBeNull();

  await page.getByRole("button", { name: "Open account menu" }).click();
  const signedOut = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/sign-out" &&
      response.request().method() === "POST",
  );
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  expect((await signedOut).status()).toBe(200);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Continue as Ada Local" })).toBeVisible();
});

test("a different first browser session cannot inherit the server-rendered owner's report", async ({
  page,
}) => {
  const ada = await signIn(page);
  const { runId } = seedBrowserRun(ada.id, "complete");
  let switched = false;
  await page.route("**/api/auth/get-session**", async (route) => {
    if (switched) {
      await route.continue();
      return;
    }
    switched = true;
    await page.request.get("/api/auth/dev-login?identity=grace");
    await route.fulfill({ response: await page.request.get("/api/auth/get-session") });
  });
  const rejected = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/run/${runId}` &&
      response.request().isNavigationRequest() &&
      response.status() === 404,
  );
  await page.goto(`/run/${runId}`, { waitUntil: "commit" });
  expect((await rejected).status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Claims in this report" })).toHaveCount(0);
});
