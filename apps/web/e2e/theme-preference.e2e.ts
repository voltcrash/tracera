import { expect, test, type Page } from "@playwright/test";

async function blockThemeStorage(page: Page, mode: "read" | "write") {
  await page.addInitScript((mode) => {
    const key = "tracera-theme";
    const bound = (area: Storage) => ({
      getItem: area.getItem.bind(area),
      setItem: area.setItem.bind(area),
      removeItem: area.removeItem.bind(area),
    });
    const local = bound(localStorage);
    const session = bound(sessionStorage);
    if (mode === "write") local.setItem(key, "light");
    Storage.prototype.getItem = function (name) {
      if (this === localStorage && name === key && mode === "read")
        throw new DOMException("Storage unavailable", "SecurityError");
      return (this === localStorage ? local : session).getItem(name);
    };
    Storage.prototype.setItem = function (name, value) {
      if (this === localStorage && name === key && mode === "write")
        throw new DOMException("Storage full", "QuotaExceededError");
      return (this === localStorage ? local : session).setItem(name, value);
    };
    Storage.prototype.removeItem = function (name) {
      if (this === localStorage && name === key && mode === "write")
        throw new DOMException("Storage unavailable", "SecurityError");
      return (this === localStorage ? local : session).removeItem(name);
    };
  }, mode);
}

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as Ada Local" }).click();
  await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
}

test("a theme choice applies in memory when persistence fails and survives route changes", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await blockThemeStorage(page, "write");
  await signIn(page);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.getByRole("button", { name: "Switch to light theme" })).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await page.evaluate(() => localStorage.getItem("tracera-theme"))).toBe("light");
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch to light theme" })).toBeVisible();
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.getByRole("button", { name: "Switch to dark theme" })).toBeVisible();
});

test("theme storage changes replace an in-memory choice and unrelated changes leave it intact", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await blockThemeStorage(page, "write");
  await signIn(page);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  const other = await context.newPage();
  try {
    await other.goto("/");
    await other.evaluate(() => localStorage.removeItem("tracera-theme"));
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await other.evaluate(() => localStorage.setItem("tracera-theme", "dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("button", { name: "Switch to light theme" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await other.evaluate(() => localStorage.setItem("unrelated-theme-test", "value"));
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await other.evaluate(() => localStorage.clear());
    await expect(page.locator("html")).toHaveClass(/dark/);
  } finally {
    await other.close();
  }
});

test("the pre-paint script follows the system theme when storage reads fail", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await blockThemeStorage(page, "read");
  await page.route("**/*", (route) =>
    route.request().resourceType() === "script" ? route.abort("failed") : route.continue(),
  );
  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
});
