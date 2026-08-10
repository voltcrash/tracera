import {
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** Always stored lowercase so email addresses are unique case-insensitively. */
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
  lineageReason: varchar("lineage_reason", { length: 32 })
    .notNull()
    .default("first_check"),
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const traceAppearances = pgTable("trace_appearances", {
  id: uuid("id").defaultRandom().primaryKey(),
  checkId: uuid("check_id")
    .notNull()
    .references(() => checks.id, { onDelete: "cascade" }),
  sourceUrl: text("source_url"),
  sourceDomain: text("source_domain"),
  occurrenceType: varchar("occurrence_type", { length: 32 }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const domains = pgTable("domains", {
  domain: text("domain").primaryKey(),
  trustScore: numeric("trust_score", { precision: 5, scale: 4 }).notNull(),
  lastUpdated: timestamp("last_updated", { withTimezone: true })
    .notNull()
    .defaultNow(),
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const alertSubscriptions = pgTable("alert_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  checkId: uuid("check_id")
    .notNull()
    .references(() => checks.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  active: varchar("active", { length: 5 }).notNull().default("true"),
  lastNotifiedCheckId: uuid("last_notified_check_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const decayEvents = pgTable("decay_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  checkId: uuid("check_id").references(() => checks.id, {
    onDelete: "set null",
  }),
  eventType: varchar("event_type", { length: 48 }).notNull(),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
