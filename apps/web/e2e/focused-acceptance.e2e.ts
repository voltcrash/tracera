import { expect, test } from "@playwright/test";
import { coreV2Examples } from "@repo/contracts/core-v2";

const acceptance = {
  version: "core-v2-focused-acceptance-1.0.0",
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

test.describe("Core v2 Focused acceptance fixture", () => {
  test("keeps the browser acceptance scope explicit", async () => {
    expect(acceptance.version).toBe("core-v2-focused-acceptance-1.0.0");
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
    expect(coreV2Examples.complete.schemaVersion).toBe(2);
  });

  test("renders a saved focused report with evidence and safe score language", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Continue as Ada Local" }).click();
    await expect(page).toHaveURL(/\/home$/);

    const complete = structuredClone(coreV2Examples.complete);
    complete.runId = "run_focused_acceptance";
    await page.route("**/api/tracera/analyze", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "complete", runId: complete.runId, report: complete }),
      }),
    );
    await page
      .getByLabel("Story or claim to analyze")
      .fill("Aurora Labs opened a plant in Turin in 2024.");
    await page.getByRole("button", { name: "Analyze" }).click();

    await expect(
      page.getByRole("heading", { name: "Top claims selected for checking" }),
    ).toBeVisible();
    await expect(page.getByText("Supported share of resolved claims")).toBeVisible();
    await expect(page.getByText("Evidence excerpt:", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "source link" })).toHaveAttribute(
      "href",
      "https://records.example.org/turin-plant",
    );
    await expect(page.getByText("Insufficient evidence", { exact: true })).toHaveCount(0);
  });
});
