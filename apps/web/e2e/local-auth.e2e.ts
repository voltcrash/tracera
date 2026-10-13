import { expect, test } from "@playwright/test";
import { executeLocalSql, sqlValue } from "./support/d1";

for (const [name, email] of [
  ["Ada", "ada@tracera.local"],
  ["Grace", "grace@tracera.local"],
] as const) {
  test(`${name} uses a real D1 session across reloads and sign-out`, async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Local development identities")).toBeVisible();
    await expect(page.getByRole("button", { name: /Continue with Google/i })).toHaveCount(0);
    await page.getByRole("button", { name: `Continue as ${name} Local` }).click();
    await expect(page).toHaveURL(/\/home$/);
    const response = await page.request.get("/api/auth/get-session");
    const session = (await response.json()) as { user: { id: string; email: string } };
    expect(session.user.email).toBe(email);
    await page.reload();
    await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
    expect(
      (await page.context().cookies()).find((cookie) => cookie.name === "tracera.session_token")
        ?.secure,
    ).toBe(false);
    const rows = executeLocalSql(
      `SELECT COUNT(*) AS count FROM sessions WHERE user_id=${sqlValue(session.user.id)};`,
    );
    expect(Number(rows[0]!.results[0]!.count)).toBeGreaterThan(0);
    await page.goto("/settings");
    await expect(page.getByText(email, { exact: true }).first()).toBeVisible();
    await page.getByRole("link", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText("Local development identities")).toBeVisible();
    expect(await (await page.request.get("/api/auth/get-session")).json()).toBeNull();
    await page.goto("/home");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText("Local development identities")).toBeVisible();
  });
}
