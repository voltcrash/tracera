import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL,
    locale: "en-US",
    timezoneId: "Asia/Kolkata",
    trace: "retain-on-failure",
  },
  webServer: {
    env: { CLOUDFLARE_CF_FETCH_ENABLED: "false", WRANGLER_SEND_METRICS: "false" },
    command:
      "node scripts/prepare-browser-tests.mjs && vp run db:migrate && vp dev --host 127.0.0.1 --port 3000 --strictPort",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
