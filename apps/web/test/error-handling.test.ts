import assert from "node:assert/strict";
import { Hono } from "hono";
import { test } from "vite-plus/test";
import { app, type Bindings } from "../src/server/index";
import {
  GENERIC_ERROR_MESSAGE,
  logServerError,
  requestIdMiddleware,
  sanitizeDiagnosticText,
} from "../src/server/error-handling";

test("request IDs are attached to raw streaming responses", async () => {
  const rawApp = new Hono();
  rawApp.use("*", requestIdMiddleware);
  rawApp.get("/stream", () => new Response("ok"));

  const response = await rawApp.request("/stream");

  assert.match(response.headers.get("x-request-id") ?? "", /^[\da-f]{8}-[\da-f-]{27}$/i);
});

test("unhandled infrastructure failures return a generic response with a request ID", async () => {
  const response = await app.request("/health", { headers: { "x-request-id": "support-42" } }, {
    DATABASE_URL: "",
  } satisfies Bindings);
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("x-request-id"), "support-42");
  assert.deepEqual(payload, {
    error: GENERIC_ERROR_MESSAGE,
    requestId: "support-42",
  });
});

test("diagnostic text redacts credentials before it is logged", () => {
  const diagnostic = sanitizeDiagnosticText(
    "postgresql://admin:super-secret@private-db/tracera?token=api-token",
  );

  assert.doesNotMatch(diagnostic, /admin|super-secret|api-token/);
  assert.match(diagnostic, /postgresql:\/\/\[REDACTED\]@private-db/);
});

test("server error logs include the request ID without the raw error object", () => {
  const originalError = console.error;
  const entries: unknown[][] = [];
  console.error = (...values) => entries.push(values);

  try {
    logServerError(
      "Database request failed",
      new Error("postgresql://admin:super-secret@private-db/tracera"),
      new Request("https://tracera.test/api/tracera/checks", {
        headers: { "x-request-id": "support-43" },
      }),
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.ok(entry);
  assert.equal((entry[1] as { requestId: string }).requestId, "support-43");
  assert.doesNotMatch(JSON.stringify(entries), /admin|super-secret/);
});
