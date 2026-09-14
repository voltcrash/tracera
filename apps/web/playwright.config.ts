import { defineConfig } from "@playwright/test";

const baseURL = process.env.TRACERA_APP_ORIGIN;
if (!baseURL) throw new Error("TRACERA_APP_ORIGIN must be configured for browser auth tests.");

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "vp run dev",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
