import { expect, test, vi } from "vite-plus/test";
import { GENERIC_ERROR_MESSAGE } from "../src/server/error-handling";
import { NONCE_HEADER } from "../src/server/nonce";
import { errorEnvelope, securedResponse } from "../src/server/response-policy";

const request = (headers: Record<string, string> = {}) =>
  new Request("https://tracera.voltcrash.com/home", {
    headers: { [NONCE_HEADER]: "abc123", ...headers },
  });

test("responses carry the security headers and a CSP for the request nonce", () => {
  const response = securedResponse(new Response("ok"), request({ "x-request-id": "req-7" }), false);
  const csp = response.headers.get("content-security-policy")!;
  expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
  expect(csp).toContain("style-src 'self' 'nonce-abc123'");
  expect(csp).toContain("upgrade-insecure-requests");
  expect(csp).not.toContain("unsafe-eval");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-request-id")).toBe("req-7");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

test("development allows Vite's eval and unnonced styles without upgrading requests", () => {
  const csp = securedResponse(new Response("ok"), request(), true).headers.get(
    "content-security-policy",
  )!;
  expect(csp).toContain("'unsafe-eval'");
  expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  expect(csp).not.toContain("upgrade-insecure-requests");
});

test("signed-in requests and cookie-setting responses are private and uncached", () => {
  const signedIn = securedResponse(
    new Response("ok"),
    request({ cookie: "tracera.session_token=value" }),
    false,
  );
  expect(signedIn.headers.get("cache-control")).toBe("private, no-store");
  const setsCookie = securedResponse(
    new Response("ok", { headers: { "set-cookie": "tracera.session_token=value" } }),
    request(),
    false,
  );
  expect(setsCookie.headers.get("cache-control")).toBe("private, no-store");
  const anonymous = securedResponse(
    new Response("ok", { headers: { "cache-control": "public, max-age=60" } }),
    request(),
    false,
  );
  expect(anonymous.headers.get("cache-control")).toBe("public, max-age=60");
});

test("unhandled failures become the generic JSON envelope with the request ID", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const response = errorEnvelope(
    request({ "x-request-id": "support-42" }),
    new Error("postgresql://admin:super-secret@db failed"),
  );
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: GENERIC_ERROR_MESSAGE, requestId: "support-42" });
  expect(JSON.stringify(error.mock.calls)).not.toMatch(/super-secret|admin/);
  error.mockRestore();
});
