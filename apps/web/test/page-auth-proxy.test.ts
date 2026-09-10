import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { getRedirectUrl } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy";

test("anonymous page requests redirect to the landing page", async () => {
  const response = await proxy(new NextRequest("https://tracera.voltcrash.com/home"));

  assert.equal(getRedirectUrl(response), "https://tracera.voltcrash.com/");
});

test("the landing page remains public", async () => {
  const response = await proxy(new NextRequest("https://tracera.voltcrash.com/"));

  assert.equal(getRedirectUrl(response), null);
});

test("the authentication error page remains public", async () => {
  const response = await proxy(
    new NextRequest("https://tracera.voltcrash.com/auth/error?error=access_denied&provider=github"),
  );

  assert.equal(getRedirectUrl(response), null);
});

test("an unverified session cookie does not redirect the landing page", async () => {
  const response = await proxy(
    new NextRequest("https://tracera.voltcrash.com/", {
      headers: { cookie: "__Secure-tracera.session_token=test-session" },
    }),
  );

  assert.equal(getRedirectUrl(response), null);
});

test("a session cookie allows a page request to continue", async () => {
  const response = await proxy(
    new NextRequest("https://tracera.voltcrash.com/home", {
      headers: { cookie: "__Secure-tracera.session_token=test-session" },
    }),
  );

  assert.equal(getRedirectUrl(response), null);
});
