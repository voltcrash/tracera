import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  GENERIC_ERROR_MESSAGE,
  logServerError,
  requestIdFor,
  sanitizeDiagnosticText,
} from "../src/server/error-handling";
import { errorEnvelope, securedResponse } from "../src/server/response-policy";

test("request IDs are attached to raw streaming responses", () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
  const response = securedResponse(
    new Response(stream),
    new Request("https://tracera.test/"),
    false,
  );

  assert.match(response.headers.get("x-request-id") ?? "", /^[\da-f]{8}-[\da-f-]{27}$/i);
});

test("a valid client request ID is kept and an unsafe one is replaced", () => {
  const request = (id: string) =>
    new Request("https://tracera.test/", { headers: { "x-request-id": id } });
  assert.equal(requestIdFor(request("support-42")), "support-42");
  assert.notEqual(requestIdFor(request("<script>")), "<script>");
});

test("unhandled infrastructure failures return a generic response with a request ID", async () => {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const response = errorEnvelope(
      new Request("https://tracera.test/api/health", { headers: { "x-request-id": "support-42" } }),
      new Error("database exploded"),
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: GENERIC_ERROR_MESSAGE,
      requestId: "support-42",
    });
  } finally {
    console.error = originalError;
  }
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
      new Request("https://tracera.test/api/runs", {
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
