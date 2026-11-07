import { expect, test, type Page } from "@playwright/test";
import { seedBrowserRun } from "./support/reports";

async function openQueuedRun(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as Ada Local" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByLabel("Story or claim to analyze")).toBeEnabled();
  const { user } = await (await page.request.get("/api/auth/get-session")).json();
  const { runId } = seedBrowserRun(user.id, "queued");
  await page.addInitScript(() => {
    class ControlledSource extends EventTarget {
      static CLOSED = 2;
      readyState = 1;
      onerror: (() => void) | null = null;
      constructor(_url: string | URL) {
        super();
        Object.assign(window, { traceStream: this });
      }
      close() {
        this.readyState = 2;
      }
    }
    window.EventSource = ControlledSource as unknown as typeof EventSource;
  });
  await page.goto(`/run/${runId}`);
  await expect(page.getByRole("button", { name: "Cancel analysis" })).toBeEnabled();
  return runId;
}

async function emit(page: Page, runId: string, version: number, changes = {}) {
  await page.evaluate(
    ({ runId, version, changes }) => {
      const stream = (window as unknown as { traceStream: EventTarget }).traceStream;
      stream.dispatchEvent(
        new MessageEvent("progress", {
          data: JSON.stringify({
            progress: {
              runId,
              status: "running",
              attempt: 1,
              version,
              cancellationRequested: false,
              publicationPending: false,
              recordedStages: [],
              currentStage: "assess_evidence",
              ...changes,
            },
            report: null,
          }),
        }),
      );
    },
    { runId, version, changes },
  );
}

test("stale and malformed events cannot regress progress, and access loss closes the stream", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const runId = await openQueuedRun(page);
  await emit(page, runId, 3);
  await expect(page.getByRole("heading", { name: "Stage: assess evidence" })).toBeVisible();
  await emit(page, runId, 2, { status: "queued", currentStage: null });
  await expect(page.getByRole("heading", { name: "Stage: assess evidence" })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { traceStream: EventTarget }).traceStream.dispatchEvent(
      new MessageEvent("progress", { data: "{" }),
    ),
  );
  await expect(page.getByRole("heading", { name: "Stage: assess evidence" })).toBeVisible();
  await expect(page.getByText("Live progress was interrupted. Reconnecting…")).toHaveCount(0);
  await page.evaluate(() => {
    const stream = (
      window as unknown as { traceStream: { readyState: number; onerror: () => void } }
    ).traceStream;
    stream.readyState = 0;
    stream.onerror();
  });
  await expect(page.getByText("Live progress was interrupted. Reconnecting…")).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { traceStream: EventTarget }).traceStream.dispatchEvent(
      new Event("open"),
    ),
  );
  await expect(page.getByText("Live progress was interrupted. Reconnecting…")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Stage: assess evidence" })).toBeVisible();
  await emit(page, runId, 4, { currentStage: null, publicationPending: true });
  await expect(page.getByRole("heading", { name: "Publishing report" })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { traceStream: EventTarget }).traceStream.dispatchEvent(
      new Event("access_lost"),
    ),
  );
  await expect(
    page.getByText("Access to this trace ended. Sign in again or reload the page."),
  ).toBeVisible();
  await emit(page, runId, 5, { status: "queued" });
  await expect(page.getByRole("heading", { name: "Publishing report" })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { traceStream: { readyState: number } }).traceStream.readyState,
    ),
  ).toBe(2);
  expect(errors).toEqual([]);
});

test("duplicate cancellation clicks send one request, failures remain visible and retry retains the run", async ({
  page,
}) => {
  const runId = await openQueuedRun(page);
  let requests = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/*serverFn/*", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    requests += 1;
    if (requests === 1) {
      await pending;
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Cancel analysis" })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  try {
    await expect(page.getByRole("button", { name: "Requesting cancellation…" })).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByText("Unable to confirm cancellation. Try again.")).toBeVisible();
  expect(requests).toBe(1);
  await emit(page, runId, 1);
  await expect(page.getByText("Unable to confirm cancellation. Try again.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel analysis" }).click();
  await expect(page.getByRole("heading", { name: "Cancellation requested" })).toBeVisible();
  expect(requests).toBe(2);
  await emit(page, runId, 2);
  await expect(page.getByRole("heading", { name: "Cancellation requested" })).toBeVisible();
  await emit(page, runId, 3, { status: "canceled" });
  await expect(page.getByRole("heading", { name: "Analysis canceled" })).toBeVisible();
});
