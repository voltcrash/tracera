import type { D1Database } from "@cloudflare/workers-types";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema.js";

export function createD1Database(binding: D1Database): DrizzleD1Database<typeof schema> {
  return drizzle(binding, { schema });
}

export { schema };
