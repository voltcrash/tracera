import { expect, test } from "@playwright/test";
import { configureDatabase, pool } from "@repo/db";

test("local identities use real sessions", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Local development identities")).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue with Google/i })).toHaveCount(0);

  await page.getByRole("button", { name: "Continue as Ada Local" }).click();
  await expect(page).toHaveURL(/\/home$/);

  const adaSession = await page.request.get("/api/tracera/auth/me");
  expect(adaSession.ok()).toBe(true);
  const ada = (await adaSession.json()).user as { id: string; email: string };
  expect(ada.email).toBe("ada@tracera.local");

  await page.reload();
  await expect(page).toHaveURL(/\/home$/);
  const sessionCookies = await page.context().cookies();
  const sessionCookie = sessionCookies.find((cookie) => cookie.name === "tracera.session_token");
  expect(sessionCookie?.secure).toBe(false);

  configureDatabase(process.env.DATABASE_URL, process.env);
  const storedSessions = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1",
    [ada.id],
  );
  expect(Number(storedSessions.rows[0]?.count ?? 0)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(new URL("/", process.env.TRACERA_APP_ORIGIN).toString());
  expect((await page.request.get("/api/tracera/auth/me")).status()).toBe(401);
});
