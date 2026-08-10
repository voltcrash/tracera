import assert from "node:assert/strict";
import test from "node:test";
import { isReusableImageMatch } from "@repo/db";

test("image deduplication accepts exact and near-identical image content", () => {
  assert.equal(isReusableImageMatch(true, 0.2, 0.98), true);
  assert.equal(isReusableImageMatch(false, 0.985, 0.98), true);
});

test("image deduplication keeps merely related images separate", () => {
  assert.equal(isReusableImageMatch(false, 0.979, 0.98), false);
  assert.equal(isReusableImageMatch(false, Number.NaN, 0.98), false);
});
