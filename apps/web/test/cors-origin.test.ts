import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { allowedCorsOrigin } from "../server/cors-origin";

test("allows the configured web origin", () => {
  assert.equal(
    allowedCorsOrigin("https://tracera.voltcrash.com", "https://tracera.voltcrash.com"),
    "https://tracera.voltcrash.com",
  );
});

test("supports multiple configured preview and production origins", () => {
  assert.equal(
    allowedCorsOrigin(
      "https://preview.tracera.voltcrash.com",
      "https://tracera.voltcrash.com, https://preview.tracera.voltcrash.com/",
    ),
    "https://preview.tracera.voltcrash.com",
  );
});

test("allows loopback web development origins", () => {
  for (const origin of [
    "http://localhost:3000",
    "https://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ]) {
    assert.equal(allowedCorsOrigin(origin, undefined), origin);
  }
});

test("rejects lookalike and unrelated origins", () => {
  for (const origin of [
    "https://tracera.voltcrash.com.attacker.example",
    "https://localhost.attacker.example:3000",
    "https://attacker.example",
  ]) {
    assert.equal(allowedCorsOrigin(origin, "https://tracera.voltcrash.com"), undefined);
  }
});
