import { expect, test, type Page } from "@playwright/test";
import { hashValue } from "@repo/ai/analysis/hashing";
import { analysisRequestIdentity } from "../src/server/analysis-controls";
import { executeLocalSql, sqlValue } from "./support/d1";
import { seedBrowserRun } from "./support/reports";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as Ada Local" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByLabel("Story or claim to analyze")).toBeEnabled();
}

test("a retry after a lost response replays the accepted trace", async ({ page }) => {
  await signIn(page);
  const requests: string[] = [];
  let acceptedRun: string | undefined;
  await page.route("**/*serverFn/*", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.postData()?.includes("idempotencyKey")) {
      await route.continue();
      return;
    }
    requests.push(request.postData()!);
    if (requests.length === 1) {
      const response = await route.fetch();
      acceptedRun = (await response.text()).match(
        /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/,
      )?.[0];
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await page.getByLabel("Story or claim to analyze").fill("The library opened in 2026.");
  await expect(page.getByRole("button", { name: "Analyze", exact: true })).toBeEnabled();
  await page.locator(".sheet-form").evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page).toHaveURL(/\/run\/[^/]+$/);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  expect(acceptedRun).toBeTruthy();
  expect(new URL(page.url()).pathname).toBe(`/run/${acceptedRun}`);
});

test("a lost response can replay a saved failed trace and open its status", async ({ page }) => {
  await signIn(page);
  const { user } = await (await page.request.get("/api/auth/get-session")).json();
  const text = "The saved failed trace should open after retry.";
  const requests: string[] = [];
  let savedRun: string | undefined;
  await page.route("**/*serverFn/*", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.postData()?.includes("idempotencyKey")) {
      await route.continue();
      return;
    }
    requests.push(request.postData()!);
    if (requests.length === 1) {
      const key = request.postData()!.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/)?.[0];
      if (!key) throw new Error("Missing submission identity");
      savedRun = seedBrowserRun(user.id, "failed").runId;
      const body = { runId: savedRun, status: "failed", reportUrl: `/run/${savedRun}` };
      const hash = analysisRequestIdentity(
        new Request(request.url()),
        { text },
        undefined,
      ).requestHash;
      const now = Date.now();
      executeLocalSql(`INSERT INTO analysis_idempotency_keys
        (user_id,endpoint,idempotency_key,request_hash,request_status,response_body,response_hash,response_status,expires_at,created_at,updated_at)
        VALUES(${sqlValue(user.id)},'startAnalysis',${sqlValue(key)},${sqlValue(hash)},'failed',${sqlValue(JSON.stringify(body))},${sqlValue(hashValue(body))},503,${now + 60_000},${now},${now});`);
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByLabel("Story or claim to analyze").fill(text);
  await expect(page.getByRole("button", { name: "Analyze", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/run/${savedRun}$`));
  await expect(page.getByText("Analysis ended", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  await expect(
    page.getByRole("navigation", { name: "Your traces" }).locator(`a[href="/run/${savedRun}"]`),
  ).toBeVisible();
});

test("only the latest attachment read can update the draft, including after removal", async ({
  page,
}) => {
  await signIn(page);
  await page.evaluate(() => {
    const NativeReader = window.FileReader;
    const pending = new Map<string, () => Promise<void>>();
    Object.assign(window, { finishImageRead: (name: string) => pending.get(name)?.() });
    window.createImageBitmap = async () => ({ width: 1, height: 1, close() {} }) as ImageBitmap;
    window.FileReader = class extends NativeReader {
      override readAsDataURL(file: Blob) {
        pending.set(
          (file as File).name,
          () =>
            new Promise<void>((resolve) => {
              this.addEventListener("loadend", () => requestAnimationFrame(() => resolve()), {
                once: true,
              });
              super.readAsDataURL(file);
            }),
        );
      }
    };
  });
  await page.getByLabel("Story or claim to analyze").fill("Keep this draft while reading.");
  const image = page.locator("#trace-image");
  const upload = (name: string) =>
    image.setInputFiles({
      name,
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aStsAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  const finish = (name: string) =>
    page.evaluate((filename) => {
      return (
        window as unknown as { finishImageRead: (value: string) => Promise<void> }
      ).finishImageRead(filename);
    }, name);

  await upload("first.png");
  await expect(page.getByRole("button", { name: "Analyze", exact: true })).toBeDisabled();
  await upload("latest.png");
  await finish("latest.png");
  await expect(page.locator(".clipping-caption")).toContainText("latest.png");
  await finish("first.png");
  await expect(page.locator(".clipping-caption")).toContainText("latest.png");
  await upload("removed.png");
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await finish("removed.png");
  await expect(page.getByAltText("Screenshot selected for analysis")).toHaveCount(0);
  await expect(page.getByLabel("Story or claim to analyze")).toHaveValue(
    "Keep this draft while reading.",
  );
  await expect(page.getByRole("button", { name: "Analyze", exact: true })).toBeEnabled();
});
