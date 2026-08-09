import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";
import { linkUserToClerk, pool } from "@repo/db";

test("a recreated Clerk identity reclaims the existing email row", async () => {
  const existingUser = {
    id: "6f3ea45a-6ab9-4d7d-b4d4-edfd88e3cc5b",
    email: "test@voltcrash.com",
    createdAt: "2026-08-09T00:00:00.000Z",
  };
  const queries: string[] = [];

  mock.method(pool, "query", async (query: unknown) => {
    queries.push(String(query));
    return { rows: [existingUser] };
  });

  const user = await linkUserToClerk({
    clerkUserId: "user_recreated",
    email: existingUser.email,
  });

  assert.deepEqual(user, existingUser);
  assert.equal(queries.length, 1);
  assert.match(queries[0] ?? "", /WHERE email = \$2\s+RETURNING/);
  assert.doesNotMatch(queries[0] ?? "", /clerk_user_id IS NULL/);
});
