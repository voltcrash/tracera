import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { assertRuntimeDatabaseRole } from "../src/index.js";

test("production requires the least-privileged runtime database role", () => {
  assert.doesNotThrow(() =>
    assertRuntimeDatabaseRole(
      "postgresql://tracera_runtime:password@example.com/tracera",
      "production",
    ),
  );
  assert.throws(
    () =>
      assertRuntimeDatabaseRole(
        "postgresql://neondb_owner:password@example.com/tracera",
        "production",
      ),
    /tracera_runtime role/,
  );
});
