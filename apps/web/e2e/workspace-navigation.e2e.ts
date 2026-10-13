import { expect, test, type Page } from "@playwright/test";
import { seedBrowserRun } from "./support/reports";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as Ada Local" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
}

test("Settings replaces the account menu with Back and keeps the theme toggle", async ({
  page,
}) => {
  await signIn(page);
  await openSettings(page);
  const rail = page.getByRole("complementary", { name: "Traces", exact: true });
  await expect(rail.getByRole("button", { name: "Open account menu" })).toHaveCount(0);
  await expect(rail.getByRole("button", { name: /Switch to .* theme/ })).toBeVisible();
  await rail.getByRole("link", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(rail.getByRole("button", { name: "Open account menu" })).toBeVisible();
  await expect(rail.getByRole("link", { name: "Back", exact: true })).toHaveCount(0);
});

test("opening Settings directly returns home", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings");
  const back = page.getByRole("link", { name: "Back", exact: true });
  await expect(back).toHaveAttribute("href", "/home");
  await back.click();
  await expect(page).toHaveURL(/\/home$/);
});

test("Back restores the originating trace, search and fragment after a Settings reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  const session = (await (await page.request.get("/api/auth/get-session")).json()) as {
    user: { id: string };
  };
  const { runId } = seedBrowserRun(session.user.id, "failed");
  const tracePath = `/run/${runId}?view=source#report`;
  await page.goto(tracePath);
  await expect(page.getByRole("heading", { name: "Analysis could not finish" })).toBeVisible();
  await openSettings(page);
  const back = page.getByRole("link", { name: "Back", exact: true });
  await expect(back).toHaveAttribute("href", tracePath);
  await page.reload();
  await expect(back).toHaveAttribute("href", tracePath);
  await back.click();
  await expect(page).toHaveURL(new URL(tracePath, page.url()).href);
  await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Settings and Back dismiss the mobile traces drawer", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const rail = page.getByRole("complementary", { name: "Traces", exact: true });
  await page.getByRole("button", { name: "Open traces", exact: true }).click();
  await expect(rail).toBeInViewport();
  await openSettings(page);
  await expect(rail).not.toHaveAttribute("data-open", "true");
  await expect(rail).not.toBeInViewport();
  await page.getByRole("button", { name: "Open traces", exact: true }).click();
  await expect(rail).toBeInViewport();
  await rail.getByRole("link", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(rail).not.toHaveAttribute("data-open", "true");
  await expect(rail).not.toBeInViewport();
  await page.getByRole("button", { name: "Open traces", exact: true }).click();
  await expect(rail.getByRole("button", { name: "Open account menu" })).toBeVisible();
  await expect(rail.getByRole("link", { name: "Back", exact: true })).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  test(`Back remains available in the ${theme} theme`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await signIn(page);
    await openSettings(page);
    const back = page.getByRole("link", { name: "Back", exact: true });
    await expect(back).toBeVisible();
    const nextTheme = theme === "light" ? "dark" : "light";
    await expect(page.getByRole("button", { name: `Switch to ${nextTheme} theme` })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`settings-back-${theme}.png`) });
    await page.getByRole("button", { name: `Switch to ${nextTheme} theme` }).click();
    await expect(page.getByRole("button", { name: `Switch to ${theme} theme` })).toBeVisible();
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
  });
}
