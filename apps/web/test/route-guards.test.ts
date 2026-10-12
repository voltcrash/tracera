import { isRedirect } from "@tanstack/react-router";
import { expect, test } from "vite-plus/test";
import { redirectSignedIn, requireUser } from "../src/lib/route-guards";

const user = {
  id: "user-1",
  email: "ada@tracera.local",
  name: "Ada",
  image: null,
  createdAt: "2026-10-12T00:00:00.000Z",
};

function thrown(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the guard to redirect.");
}

test("workspace pages send anonymous visitors to the landing page", () => {
  const redirect = thrown(() => requireUser(null));
  expect(isRedirect(redirect)).toBe(true);
  expect((redirect as { options: { to: string } }).options.to).toBe("/");
});

test("workspace pages pass the signed-in user into route context", () => {
  expect(requireUser(user)).toBe(user);
});

test("the landing page sends signed-in users to their workspace", () => {
  const redirect = thrown(() => redirectSignedIn(user));
  expect(isRedirect(redirect)).toBe(true);
  expect((redirect as { options: { to: string } }).options.to).toBe("/home");
});

test("the landing page stays open to anonymous visitors", () => {
  expect(() => redirectSignedIn(null)).not.toThrow();
});
