import { expect, test, type Page } from "@playwright/test";

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
