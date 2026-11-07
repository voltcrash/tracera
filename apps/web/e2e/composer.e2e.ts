import { expect, test, type Page } from "@playwright/test";

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
