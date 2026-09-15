import { expect, test } from "@playwright/test";
import { configureDatabase, pool } from "@repo/db";
import { OFFLINE_FIXTURE_IMAGE, OFFLINE_FIXTURE_URL, OFFLINE_INACCESSIBLE_URL } from "@repo/ai";

const coffee =
  "A new study found that drinking coffee after 2pm doubles the risk of insomnia for all adults.";

test("local analysis uses offline fixtures with real controls and persistence", async ({
  browser,
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as Ada Local" }).click();
  await expect(page).toHaveURL(/\/home$/);

  const textKey = crypto.randomUUID();
  const textResponse = await analyze(page, { text: coffee }, textKey);
  expect(textResponse.status()).toBe(201);
  const textResult = await textResponse.json();
  expect(textResult.analysisMode).toBe("fixture");
  expect(textResult.claims[0].verdict).toBe("supported");
  expect(textResult.claims[0].consideredSources[0].url).toContain("tracera.example");

  const replay = await analyze(page, { text: coffee }, textKey);
  expect(replay.status()).toBe(201);
  expect(replay.headers()["x-idempotency-replayed"]).toBe("true");
  expect((await replay.json()).check.id).toBe(textResult.check.id);

  for (const input of [
    { url: OFFLINE_FIXTURE_URL },
    { image: OFFLINE_FIXTURE_IMAGE, imageMimeType: "image/png" },
    { text: "Harbor City planted 10,000 trees during 2025, according to its annual report." },
  ]) {
    const response = await analyze(page, input, crypto.randomUUID());
    expect(response.status()).toBe(201);
    expect((await response.json()).analysisMode).toBe("fixture");
  }

  const inaccessible = await analyze(page, { url: OFFLINE_INACCESSIBLE_URL }, crypto.randomUUID());
  expect(inaccessible.status()).toBe(422);
  expect((await inaccessible.json()).code).toBe("fixture_unavailable");
  const unknown = await analyze(
    page,
    { text: "An unregistered fixture scenario." },
    crypto.randomUUID(),
  );
  expect(unknown.status()).toBe(422);
  expect((await unknown.json()).code).toBe("fixture_unavailable");
  const providerFailure = await analyze(
    page,
    { text: "Fixture provider failure: Atlas Transit added two electric buses in 2026." },
    crypto.randomUUID(),
  );
  expect(providerFailure.status()).toBe(503);
  expect((await providerFailure.json()).code).toBe("analysis_unavailable");

  await page.goto(`/trace/${textResult.check.id}`);
  await expect(page.getByTestId("synthetic-fixture-badge")).toBeVisible();

  const coreKey = crypto.randomUUID();
  const coreSubmission = await analyzeV2(page, { text: coffee }, coreKey);
  expect(coreSubmission.status()).toBe(202);
  const coreRun = await coreSubmission.json();
  expect(coreRun.schemaVersion).toBe(2);
  expect(coreRun.status).toBe("queued");
  expect(coreRun.progressUrl).toBe(`/api/tracera/v2/runs/${coreRun.runId}`);
  const coreReplay = await analyzeV2(page, { text: coffee }, coreKey);
  expect(coreReplay.status()).toBe(202);
  expect(coreReplay.headers()["x-idempotency-replayed"]).toBe("true");
  expect((await coreReplay.json()).runId).toBe(coreRun.runId);
  const resumed = await page.request.get(`/api/tracera/v2/runs/${coreRun.runId}`);
  expect(resumed.status()).toBe(200);
  expect((await resumed.json()).progress.status).toBe("queued");
  const disconnectedEvent = await page.evaluate(async (runId) => {
    const controller = new AbortController();
    const response = await fetch(`/api/tracera/v2/runs/${runId}/events`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let frames = "";
    while (!frames.includes("event: progress")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      frames += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    return frames;
  }, coreRun.runId);
  expect(disconnectedEvent).toContain('"status":"queued"');
  expect(
    (await (await page.request.get(`/api/tracera/v2/runs/${coreRun.runId}`)).json()).progress
      .status,
  ).toBe("queued");
  const canceled = await page.request.post(`/api/tracera/v2/runs/${coreRun.runId}/cancel`);
  expect(canceled.status()).toBe(202);
  expect(
    (await (await page.request.get(`/api/tracera/v2/runs/${coreRun.runId}`)).json()).progress
      .status,
  ).toBe("canceled");
  expect((await page.request.post(`/api/tracera/v2/runs/${coreRun.runId}/cancel`)).status()).toBe(
    409,
  );

  const graceContext = await browser.newContext();
  const gracePage = await graceContext.newPage();
  await gracePage.goto("/");
  await gracePage.getByRole("button", { name: "Continue as Grace Local" }).click();
  const privateDetail = await gracePage.request.get(`/api/tracera/checks/${textResult.check.id}`);
  expect(privateDetail.status()).toBe(404);
  const privateCoreRun = await gracePage.request.get(`/api/tracera/v2/runs/${coreRun.runId}`);
  expect(privateCoreRun.status()).toBe(404);
  expect(
    (await gracePage.request.get(`/api/tracera/v2/runs/${coreRun.runId}/events`)).status(),
  ).toBe(404);
  expect(
    (await gracePage.request.post(`/api/tracera/v2/runs/${coreRun.runId}/cancel`)).status(),
  ).toBe(404);
  expect(
    (
      await gracePage.request.get(
        `/api/tracera/v2/runs/${coreRun.runId}/evidence/${encodeURIComponent("snapshot")}`,
      )
    ).status(),
  ).toBe(404);
  await graceContext.close();

  configureDatabase(process.env.DATABASE_URL, process.env);
  const persistence = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM checks WHERE owner_user_id = (SELECT id FROM users WHERE email = $1) AND analysis ->> 'analysisMode' = 'fixture'",
    ["ada@tracera.local"],
  );
  const spend = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM ai_provider_spend WHERE provider_key = 'fixture'",
  );
  expect(Number(persistence.rows[0]?.count ?? 0)).toBe(4);
  expect(Number(spend.rows[0]?.count ?? 0)).toBeGreaterThan(0);
});

function analyze(
  page: import("@playwright/test").Page,
  input: Record<string, unknown>,
  idempotencyKey: string,
) {
  return page.request.post("/api/tracera/analyze", {
    headers: { "Idempotency-Key": idempotencyKey },
    data: input,
  });
}

function analyzeV2(
  page: import("@playwright/test").Page,
  input: Record<string, unknown>,
  idempotencyKey: string,
) {
  return page.request.post("/api/tracera/v2/analyze", {
    headers: { "Idempotency-Key": idempotencyKey },
    data: input,
  });
}
