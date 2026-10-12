import { seedBrowserRun } from "./support/reports";
import { expect, test } from "@playwright/test";
import { analysisExamples } from "@repo/contracts/analysis";

const acceptance = {
  version: "tracera-analysis-acceptance-1.0.0",
  cases: [
    "pasted article text",
    "public link submission",
    "pasted or uploaded screenshot",
    "three selected claims",
    "null score with unresolved evidence",
    "exact evidence excerpt links",
    "provider failure messaging",
    "saved report reload",
  ],
} as const;

test.describe("Tracera analysis acceptance fixture", () => {
  test("keeps the browser acceptance scope explicit", async () => {
    expect(acceptance.version).toBe("tracera-analysis-acceptance-1.0.0");
    expect(acceptance.cases).toEqual([
      "pasted article text",
      "public link submission",
      "pasted or uploaded screenshot",
      "three selected claims",
      "null score with unresolved evidence",
      "exact evidence excerpt links",
      "provider failure messaging",
      "saved report reload",
    ]);
    expect(analysisExamples.complete.schemaVersion).toBe(2);
  });

  test("completes a real fixture text Workflow with safe score language", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await signIn(page);
    await page
      .getByLabel("Story or claim to analyze")
      .fill("The city opened a public library in 2026. The library has 20000 books.");
    await page.getByRole("button", { name: "Analyze" }).click();
    await expect(page).toHaveURL(/\/run\/[^/]+$/);
    await expect(
      page.getByRole("heading", { name: "Top claims selected for checking" }),
    ).toBeVisible();
    await expect(page.getByText("Supported share of resolved claims")).toBeVisible();
    await expect(page.getByText("Insufficient evidence", { exact: true })).toBeVisible();
    await expect(page.getByText("unverified", { exact: true }).first()).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Top claims selected for checking" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
});

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as Ada Local" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await page.waitForLoadState("load");
  await expect(page.getByLabel("Story or claim to analyze")).toBeEnabled();
  return (
    (await (await page.request.get("/api/auth/get-session")).json()) as { user: { id: string } }
  ).user;
}

for (const [name, text] of [
  ["public link", "https://news.example/library"],
  [
    "three selected claims",
    "The city opened a public library in 2026. The library has 20000 books. The city built a public school in 2025. The school has 500 students.",
  ],
] as const) {
  test(`a real fixture Workflow accepts ${name}`, async ({ page }) => {
    await signIn(page);
    await page.getByLabel("Story or claim to analyze").fill(text);
    await page.getByRole("button", { name: "Analyze" }).click();
    await expect(page).toHaveURL(/\/run\/[^/]+$/);
    await expect(
      page.getByRole("heading", { name: "Top claims selected for checking" }),
    ).toBeVisible();
    await expect(page.getByText("Insufficient evidence", { exact: true })).toBeVisible();
    if (name === "three selected claims")
      await expect(page.getByText("unverified", { exact: true })).toHaveCount(3);
  });
}

test("a screenshot runs the real OCR fixture and keeps visual uncertainty explicit", async ({
  page,
}) => {
  await signIn(page);
  const image = page.locator("#trace-image");
  await expect(image).toBeEnabled();
  await image.setInputFiles({
    name: "screenshot.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aStsAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(
    page.getByRole("heading", { name: "Top claims selected for checking" }),
  ).toBeVisible();
  await expect(page.getByText("Image authenticity is not assessed by OCR.")).toBeVisible();
  await expect(page.getByText("Insufficient evidence", { exact: true })).toBeVisible();
});

test("saved D1 evidence renders, downloads its exact excerpt, and survives reload", async ({
  page,
}) => {
  const user = await signIn(page);
  const { runId, report } = seedBrowserRun(user.id, "complete");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/run/${runId}`);
  await expect(
    page.getByRole("heading", { name: "Top claims selected for checking" }),
  ).toBeVisible();
  const source = page.getByRole("link", { name: "source link" }).first();
  await expect(source).toHaveAttribute("href", "https://records.example.org/turin-plant");
  const excerpt = page.locator('a[href*="/evidence/"]').first();
  const url = await excerpt.getAttribute("href");
  if (!url) throw new Error("Evidence excerpt has no local URL.");
  const evidence = await page.request.get(url);
  expect(evidence.status()).toBe(200);
  const evidenceUrl = new URL(url, page.url());
  const snapshot = report!.snapshots.find(({ id }) => evidenceUrl.pathname.endsWith(`/${id}`))!;
  const start = Number(evidenceUrl.searchParams.get("start"));
  const end = Number(evidenceUrl.searchParams.get("end"));
  expect(await evidence.json()).toEqual({
    schemaVersion: 2,
    snapshot,
    excerpt: { start, end, quote: snapshot.normalizedText.slice(start, end) },
  });
  await page.reload();
  await expect(source).toHaveAttribute("href", "https://records.example.org/turin-plant");
  expect(errors).toEqual([]);
});

test("a failed saved run shows a safe message instead of its internal provider error", async ({
  page,
}) => {
  const user = await signIn(page);
  const { runId } = seedBrowserRun(user.id, "failed");
  await page.goto(`/run/${runId}`);
  await expect(page.getByRole("heading", { name: "Analysis could not finish" })).toBeVisible();
  await expect(page.getByText("Analysis ended", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("synthetic-provider-canary");
});

test("a queued run can be canceled through the server function and progress stream", async ({
  page,
}) => {
  const user = await signIn(page);
  const { runId } = seedBrowserRun(user.id, "queued");
  await page.goto(`/run/${runId}`);
  await page.getByRole("button", { name: "Cancel analysis" }).click();
  await expect(page.getByRole("heading", { name: "Analysis canceled" })).toBeVisible();
  await expect(page.getByText("Analysis ended", { exact: true })).toBeVisible();
});
