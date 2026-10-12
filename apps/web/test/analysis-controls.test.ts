import { createD1AdmissionRepository } from "@repo/db/d1";
import { createTestRuntime, seedUser } from "@repo/db/test-runtime";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import {
  admitAnalysis,
  analysisAdmissionError,
  analysisControlConfig,
  analysisControlStatus,
  analysisRequestIdentity,
  readIdempotencyKey,
} from "../src/server/analysis-controls";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
beforeAll(async () => {
  runtime = await createTestRuntime();
  await seedUser(runtime.db, "ada");
});
afterAll(async () => {
  await runtime?.dispose();
});

const request = (ip: string) =>
  new Request("https://tracera.example/_serverFn/start", { headers: { "cf-connecting-ip": ip } });

test("the client IP comes from Cloudflare's connecting IP header first", () => {
  const body = { text: "A claim." };
  const viaCloudflare = analysisRequestIdentity(
    new Request("https://tracera.example/", {
      headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" },
    }),
    body,
    "secret",
  );
  expect(viaCloudflare.ipHash).toBe(
    analysisRequestIdentity(request("203.0.113.7"), body, "secret").ipHash,
  );
  expect(viaCloudflare.ipHash).not.toBe(
    analysisRequestIdentity(request("198.51.100.1"), body, "secret").ipHash,
  );
});

test("limits fall back to defaults when settings are absent or invalid", () => {
  const config = analysisControlConfig({
    ANALYSIS_DAILY_QUOTA: "5",
    ANALYSIS_USER_RATE_LIMIT: "-1",
  });
  expect(config.dailyQuota).toBe(5);
  expect(config.userRateLimit).toBe(30);
  expect(config.dailySpendUsd).toBe(25);
});

test("idempotency keys must be 1 to 255 printable ASCII characters", () => {
  const read = (value?: string) =>
    readIdempotencyKey(
      new Request("https://tracera.example/", {
        headers: value === undefined ? {} : { "idempotency-key": value },
      }),
    ).valid;
  expect(read("key-1")).toBe(true);
  expect(read()).toBe(false);
  expect(read("x".repeat(256))).toBe(false);
  expect(read("café")).toBe(false);
});

test("admission runs through the D1 repository and maps rejections to typed errors", async () => {
  const store = createD1AdmissionRepository({ database: runtime.db });
  const config = { ...analysisControlConfig({}), userConcurrencyLimit: 1 };
  const admit = (key: string) =>
    admitAnalysis({
      userId: "ada",
      request: request("203.0.113.9"),
      endpoint: "startAnalysis",
      body: { text: key },
      idempotencyKey: key,
      forceReanalysis: false,
      config,
      secret: "secret",
      store,
    });
  expect((await admit("first")).kind).toBe("admitted");
  const second = await admit("second");
  expect(second.kind).toBe("rejected");
  if (second.kind !== "rejected") return;
  const error = analysisAdmissionError(second);
  expect(error.code).toBe("user_concurrency_limited");
  expect(analysisControlStatus(error.code)).toBe(429);
});

test("an unavailable admission store becomes analysis_controls_unavailable", async () => {
  await expect(
    admitAnalysis({
      userId: "ada",
      request: request("203.0.113.9"),
      endpoint: "startAnalysis",
      body: {},
      idempotencyKey: "broken",
      forceReanalysis: false,
      config: analysisControlConfig({}),
      store: {
        beginAnalysisAdmission: async () => {
          throw new Error("D1 unavailable");
        },
      },
    }),
  ).rejects.toMatchObject({ code: "analysis_controls_unavailable" });
});
