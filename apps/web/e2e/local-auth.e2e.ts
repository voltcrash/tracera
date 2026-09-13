import { expect, test } from "@playwright/test";
import { configureDatabase, persistCheck, pool } from "@repo/db";

const FIXTURE_PREFIX = "L04 browser fixture:";

test("local identities use real sessions and keep private traces isolated", async ({
  browser,
  page,
}) => {
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

  const marker = `${FIXTURE_PREFIX} ${crypto.randomUUID()}`;
  const privateCheck = await persistCheck({
    rawInput: marker,
    headline: marker,
    inputEmbedding: Array.from({ length: 1024 }, () => 0),
    traceraScore: { overall: 100 },
    analysis: { claims: [], score: { overall: 100 } },
    claims: [],
    ownerUserId: ada.id,
  });

  const graceContext = await browser.newContext();
  const gracePage = await graceContext.newPage();
  await gracePage.goto("/");
  await gracePage.getByRole("button", { name: "Continue as Grace Local" }).click();
  await expect(gracePage).toHaveURL(/\/home$/);
  const graceSession = await gracePage.request.get("/api/tracera/auth/me");
  expect((await graceSession.json()).user.email).toBe("grace@tracera.local");

  const crossTenantDetail = await gracePage.request.get(`/api/tracera/checks/${privateCheck.id}`);
  expect(crossTenantDetail.status()).toBe(404);
  const crossTenantList = await gracePage.request.get(
    `/api/tracera/checks?q=${encodeURIComponent(marker)}`,
  );
  expect((await crossTenantList.json()).checks).toEqual([]);
  await graceContext.close();

  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(new URL("/", process.env.TRACERA_APP_ORIGIN).toString());
  expect((await page.request.get("/api/tracera/auth/me")).status()).toBe(401);
});
