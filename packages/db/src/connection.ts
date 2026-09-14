import { neonConfig, Pool as NeonPool } from "@neondatabase/serverless";
import { TRACERA_PROFILES, type EnvironmentValues } from "@repo/environment";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import pg from "pg";

/** Neon's pool implements the node-postgres API, so both transports share its types. */
export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;
export type DatabaseTransport = "node-postgres" | "neon-serverless";

export function databaseTransportFor(environment: EnvironmentValues): DatabaseTransport {
  const profile = environment.TRACERA_PROFILE;
  if (!TRACERA_PROFILES.includes(profile as (typeof TRACERA_PROFILES)[number])) {
    throw new Error("TRACERA_PROFILE must be selected before a database pool is created.");
  }
  return profile === "deployed" ? "neon-serverless" : "node-postgres";
}

/**
 * Creates a pool for an already validated connection string. Local and test
 * profiles use standard PostgreSQL TCP; the deployed profile keeps Neon's
 * serverless transport.
 */
export function createDatabasePool(connectionString: string, environment: EnvironmentValues) {
  const transport = databaseTransportFor(environment);
  if (transport === "neon-serverless") {
    // Serverless instances may handle more than one request, but WebSocket
    // connections cannot outlive the request that created them. Route
    // standalone Pool queries over Neon's stateless HTTP transport instead;
    // interactive transactions still use WebSockets and destroy their clients.
    neonConfig.poolQueryViaFetch = true;
    const pool = new NeonPool({ connectionString });
    return {
      transport,
      pool: pool as unknown as DatabasePool,
      db: drizzleNeon({ client: pool }) as unknown as ReturnType<typeof drizzleNodePostgres>,
    };
  }
  const pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  return { transport, pool, db: drizzleNodePostgres({ client: pool }) };
}

/** Stands in until a validated target is configured, so no default PG* target is ever used. */
export function createUnconfiguredDatabase() {
  const unavailable = () =>
    Promise.reject(new Error("DATABASE_URL must be configured for the Tracera server."));
  const pool = {
    query: unavailable,
    connect: unavailable,
    end: () => Promise.resolve(),
    on: () => pool,
  } as unknown as DatabasePool;
  return { transport: null, pool, db: drizzleNodePostgres({ client: pool }) };
}
