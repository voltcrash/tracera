import type { D1Database } from "@cloudflare/workers-types";
import { betterAuth } from "better-auth/minimal";
import type { Auth, BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./src/auth-schema.js";

const options: BetterAuthOptions = {
  database: drizzleAdapter(drizzle({} as D1Database, { schema }), { provider: "sqlite", schema }),
  baseURL: "http://localhost:3000",
  secret: "tracera-schema-generation-local-only-secret",
  user: { modelName: "users" },
  session: { modelName: "sessions" },
  account: { modelName: "accounts", encryptOAuthTokens: true },
  verification: { modelName: "verifications" },
  advanced: { database: { generateId: "uuid" } },
  emailAndPassword: { enabled: false },
};

export const auth: Auth = betterAuth(options);
