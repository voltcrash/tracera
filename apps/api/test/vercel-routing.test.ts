import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { serverPath } from "../src/vercel.js";

const WEB_HOST = "tracera.voltcrash.com";
const API_HOST = "api.tracera.voltcrash.com";

test("keeps same-origin auth and API paths", () => {
  assert.equal(serverPath("/api/auth/callback/google", WEB_HOST), "/api/auth/callback/google");
  assert.equal(serverPath("/api/tracera/checks", WEB_HOST), "/api/tracera/checks");
  assert.equal(serverPath("/api/health", WEB_HOST), "/api/tracera/health");
});

test("restores the API prefix for the public API hostname", () => {
  assert.equal(serverPath("/v1/checks", API_HOST), "/api/tracera/v1/checks");
  assert.equal(serverPath("/", API_HOST), "/api/tracera");
});

test("drops trailing slashes so mounted routes match", () => {
  assert.equal(serverPath("/api/tracera/", WEB_HOST), "/api/tracera");
});
