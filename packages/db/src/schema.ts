import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  /** Always stored lowercase so email addresses are unique case-insensitively. */
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_token_idx").on(table.token),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("accounts_provider_account_idx").on(table.providerId, table.accountId),
    index("accounts_user_id_idx").on(table.userId),
  ],
);

export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

export const checks = pgTable("checks", {
  id: uuid("id").defaultRandom().primaryKey(),
  inputType: varchar("input_type", { length: 32 }).notNull(),
  rawInput: text("raw_input").notNull(),
  sourceDomain: text("source_domain"),
  sourceUrl: text("source_url"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  groundZero: jsonb("ground_zero"),
  prompts: jsonb("prompts").notNull().default([]),
  supersedesCheckId: uuid("supersedes_check_id"),
  lineageReason: varchar("lineage_reason", { length: 32 }).notNull().default("first_check"),
  nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
  /** Null preserves public/anonymous traces created before accounts were introduced. */
  ownerUserId: uuid("owner_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  visibility: varchar("visibility", { length: 16 }).notNull().default("public"),
  /** Embedding of rawInput, used to avoid re-running near-identical checks. */
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
  traceraScore: jsonb("tracera_score").notNull(),
  /** Complete structured pipeline result, used when a fresh check is reused. */
  analysis: jsonb("analysis").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const traceAppearances = pgTable("trace_appearances", {
  id: uuid("id").defaultRandom().primaryKey(),
  checkId: uuid("check_id")
    .notNull()
    .references(() => checks.id, { onDelete: "cascade" }),
  sourceUrl: text("source_url"),
  sourceDomain: text("source_domain"),
  occurrenceType: varchar("occurrence_type", { length: 32 }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per analysis a signed-in user runs, including analyses served from a
 * recent identical trace. A reused trace keeps its original owner, so ownership
 * alone cannot answer what a given account has checked.
 */
export const analysisHistory = pgTable(
  "analysis_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    checkId: uuid("check_id")
      .notNull()
      .references(() => checks.id, { onDelete: "cascade" }),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("analysis_history_user_time_idx").on(table.userId, table.analyzedAt.desc()),
    index("analysis_history_user_check_idx").on(table.userId, table.checkId),
  ],
);

export const claims = pgTable("claims", {
  id: uuid("id").defaultRandom().primaryKey(),
  checkId: uuid("check_id")
    .notNull()
    .references(() => checks.id, { onDelete: "cascade" }),
  claimText: text("claim_text").notNull(),
  claimType: varchar("claim_type", { length: 64 }).notNull(),
  checkability: varchar("checkability", { length: 32 }).notNull(),
  verdict: varchar("verdict", { length: 32 }),
  confidence: numeric("confidence", { precision: 5, scale: 4 }),
  reasoning: text("reasoning"),
  evidenceQuality: numeric("evidence_quality", { precision: 5, scale: 4 }),
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const domains = pgTable("domains", {
  domain: text("domain").primaryKey(),
  trustScore: numeric("trust_score", { precision: 5, scale: 4 }).notNull(),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
});

export const domainTrustEvents = pgTable("domain_trust_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  domain: text("domain")
    .notNull()
    .references(() => domains.domain, { onDelete: "cascade" }),
  checkId: uuid("check_id").references(() => checks.id, {
    onDelete: "set null",
  }),
  reviewerUserId: uuid("reviewer_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  signalType: varchar("signal_type", { length: 32 }).notNull(),
  previousScore: numeric("previous_score", {
    precision: 5,
    scale: 4,
  }).notNull(),
  proposedScore: numeric("proposed_score", {
    precision: 5,
    scale: 4,
  }).notNull(),
  appliedScore: numeric("applied_score", { precision: 5, scale: 4 }),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const alertSubscriptions = pgTable("alert_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  checkId: uuid("check_id")
    .notNull()
    .references(() => checks.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  active: varchar("active", { length: 5 }).notNull().default("true"),
  lastNotifiedCheckId: uuid("last_notified_check_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const decayEvents = pgTable("decay_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  checkId: uuid("check_id").references(() => checks.id, {
    onDelete: "set null",
  }),
  eventType: varchar("event_type", { length: 48 }).notNull(),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
