import { isRedirect } from "@tanstack/react-router";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { redirectSignedIn, requireUser } from "../src/lib/route-guards";
import { readSessionUser } from "../src/server/session.server";
import { createWorkerTestEnv, ORIGIN, signIn } from "./support/worker-env";

let harness: Awaited<ReturnType<typeof createWorkerTestEnv>>;
let cookie: string;
beforeAll(async () => {
  harness = await createWorkerTestEnv();
  cookie = (await signIn(harness.env, "ada")).cookie;
});
afterAll(async () => {
  await harness?.dispose();
});

const session = (headers: HeadersInit = {}) =>
  readSessionUser(harness.env, new Request(`${ORIGIN}/home`, { headers }));
const redirectTarget = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (isRedirect(error)) return error.options.to;
    throw error;
  }
  return null;
};

test("an anonymous D1 session is sent from the workspace to the landing page", async () => {
  const user = await session();
  expect(redirectTarget(() => requireUser(user))).toBe("/");
  expect(redirectTarget(() => redirectSignedIn(user))).toBeNull();
});

test("a signed-in D1 session enters the workspace and skips the landing page", async () => {
  const user = await session({ cookie });
  expect(redirectTarget(() => requireUser(user))).toBeNull();
  expect(redirectTarget(() => redirectSignedIn(user))).toBe("/home");
});

test("a forged session cookie is treated as anonymous", async () => {
  const user = await session({ cookie: "tracera.session_token=forged.value" });
  expect(redirectTarget(() => requireUser(user))).toBe("/");
});
