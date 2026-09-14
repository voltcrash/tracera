import assert from "node:assert/strict";
import { Pool as NeonPool } from "@neondatabase/serverless";
import pg from "pg";
import { test } from "vite-plus/test";
import {
  createDatabasePool,
  createUnconfiguredDatabase,
  databaseTransportFor,
} from "../src/connection.js";

test("local and test profiles use node-postgres while deployed keeps Neon", async () => {
  const local = createDatabasePool("postgresql://tracera_runtime:password@127.0.0.1:25432/db", {
    TRACERA_PROFILE: "local",
  });
  const deployed = createDatabasePool("postgresql://tracera_runtime:password@db.example/db", {
    TRACERA_PROFILE: "deployed",
  });
  try {
    assert.equal(local.transport, "node-postgres");
    assert.ok(local.pool instanceof pg.Pool);
    assert.equal(databaseTransportFor({ TRACERA_PROFILE: "test" }), "node-postgres");
    assert.equal(deployed.transport, "neon-serverless");
    assert.ok((deployed.pool as unknown) instanceof NeonPool);
  } finally {
    await Promise.all([local.pool.end(), deployed.pool.end()]);
  }
});

test("a pool cannot be created without a selected profile", () => {
  assert.throws(
    () => createDatabasePool("postgresql://tracera_runtime:password@127.0.0.1:25432/db", {}),
    /TRACERA_PROFILE must be selected/,
  );
});

test("an unconfigured database never falls back to default PostgreSQL settings", async () => {
  const { pool } = createUnconfiguredDatabase();
  await assert.rejects(pool.query("SELECT 1"), /DATABASE_URL must be configured/);
  await assert.rejects(pool.connect(), /DATABASE_URL must be configured/);
});
