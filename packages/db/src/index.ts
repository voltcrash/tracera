import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";

export const EMBEDDING_DIMENSIONS = 1024;

let activeConnectionString =
  process.env.DATABASE_URL ?? "postgresql://localhost:5432/tracera";

/**
 * The Neon driver uses WebSockets in Workers and remains compatible with the
 * node-postgres API used by this package. Configure it from the Worker binding
 * before handling a request; local development keeps using DATABASE_URL.
 */
export let pool = new Pool({ connectionString: activeConnectionString });
export let db = drizzle({ client: pool });

export function configureDatabase(connectionString: string | undefined) {
  if (!connectionString || connectionString === activeConnectionString) return;
  activeConnectionString = connectionString;
  pool = new Pool({ connectionString });
  db = drizzle({ client: pool });
}

export interface StoredClaim {
  claimText: string;
  claimType: string;
  checkability: string;
  verdict: string;
  confidence: number;
  reasoning: string[];
  evidenceQuality: number;
  embedding: number[];
}

export interface StoredAnalysis {
  claims: unknown[];
  score: unknown;
}

export interface CachedCheck {
  id: string;
  rawInput: string;
  traceraScore: unknown;
  analysis: StoredAnalysis;
  createdAt: string;
  similarity: number;
  expiresAt: string;
}

export interface GroundZeroCorpusHistoryItem {
  checkId: string;
  sourceUrl: string | null;
  sourceDomain: string | null;
  publishedAt: string | null;
  createdAt: string;
}

/**
 * Returns prior traces of the exact publisher URLs considered for Ground Zero.
 * This deliberately avoids a broad text/domain search: a private or merely
 * similar check is not evidence that a story first appeared at a publisher.
 */
export async function findGroundZeroCorpusHistory(
  urls: string[],
  ownerUserId?: string,
): Promise<GroundZeroCorpusHistoryItem[]> {
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  if (!uniqueUrls.length) return [];
  const result = await pool.query<{
    id: string;
    source_url: string | null;
    source_domain: string | null;
    published_at: string | null;
    created_at: string;
  }>(
    `SELECT id, source_url, source_domain, published_at, created_at
       FROM checks
      WHERE (source_url = ANY($1::text[]) OR raw_input = ANY($1::text[]))
        AND (visibility = 'public' OR owner_user_id = $2)
      ORDER BY created_at ASC
      LIMIT 20`,
    [uniqueUrls, ownerUserId ?? null],
  );
  return result.rows.map((row) => ({
    checkId: row.id,
    sourceUrl: row.source_url,
    sourceDomain: row.source_domain,
    publishedAt: row.published_at,
    createdAt: row.created_at,
  }));
}

export interface AuthUser {
  id: string;
  email: string;
  createdAt: string;
}

interface AuthUserWithPassword extends AuthUser {
  passwordHash: string;
}

export async function createUser(input: {
  email: string;
  passwordHash: string;
}): Promise<AuthUser | null> {
  const result = await pool.query<AuthUser>(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email, created_at AS "createdAt"`,
    [input.email, input.passwordHash],
  );
  return result.rows[0] ?? null;
}

export async function findUserByEmail(
  email: string,
): Promise<AuthUserWithPassword | null> {
  const result = await pool.query<AuthUserWithPassword>(
    `SELECT id, email, password_hash AS "passwordHash", created_at AS "createdAt"
     FROM users
     WHERE email = $1
     LIMIT 1`,
    [email],
  );
  return result.rows[0] ?? null;
}

export async function createAuthSession(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}) {
  await pool.query(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [input.userId, input.tokenHash, input.expiresAt],
  );
}

export async function findUserBySessionTokenHash(
  tokenHash: string,
): Promise<AuthUser | null> {
  const result = await pool.query<AuthUser>(
    `SELECT users.id, users.email, users.created_at AS "createdAt"
     FROM auth_sessions
     INNER JOIN users ON users.id = auth_sessions.user_id
     WHERE auth_sessions.token_hash = $1
       AND auth_sessions.expires_at > NOW()
     LIMIT 1`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

export async function deleteAuthSession(tokenHash: string) {
  await pool.query("DELETE FROM auth_sessions WHERE token_hash = $1", [
    tokenHash,
  ]);
}

export async function listAuthSessions(userId: string) {
  const result = await pool.query<{
    id: string;
    created_at: string;
    expires_at: string;
  }>(
    "SELECT id, created_at, expires_at FROM auth_sessions WHERE user_id = $1 AND expires_at > NOW() ORDER BY created_at DESC",
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
}
export async function deleteAuthSessionById(userId: string, sessionId: string) {
  await pool.query("DELETE FROM auth_sessions WHERE user_id = $1 AND id = $2", [
    userId,
    sessionId,
  ]);
}
export async function createAccountToken(input: {
  userId: string;
  tokenHash: string;
  kind: "verify_email" | "reset_password";
  expiresAt: Date;
}) {
  await pool.query(
    "INSERT INTO account_tokens (user_id, token_hash, kind, expires_at) VALUES ($1, $2, $3, $4)",
    [input.userId, input.tokenHash, input.kind, input.expiresAt],
  );
}
export async function consumeAccountToken(
  tokenHash: string,
  kind: "verify_email" | "reset_password",
) {
  const result = await pool.query<{ user_id: string }>(
    "UPDATE account_tokens SET used_at = NOW() WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > NOW() RETURNING user_id",
    [tokenHash, kind],
  );
  return result.rows[0]?.user_id ?? null;
}
export async function markEmailVerified(userId: string) {
  await pool.query(
    "UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = $1",
    [userId],
  );
}
export async function updateUserPassword(userId: string, passwordHash: string) {
  await pool.query(
    "UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1",
    [userId, passwordHash],
  );
  await pool.query("DELETE FROM auth_sessions WHERE user_id = $1", [userId]);
}

export async function setMediaDietPreference(
  userId: string,
  enabled: boolean,
  frequency: "weekly" | "monthly",
) {
  await pool.query(
    `INSERT INTO media_diet_preferences (user_id, enabled, frequency) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, frequency = EXCLUDED.frequency, updated_at = NOW()`,
    [userId, enabled, frequency],
  );
}
export async function getMediaDietPreference(userId: string) {
  const result = await pool.query<{
    enabled: boolean;
    frequency: "weekly" | "monthly";
  }>(
    "SELECT enabled, frequency FROM media_diet_preferences WHERE user_id = $1",
    [userId],
  );
  return result.rows[0] ?? { enabled: false, frequency: "monthly" as const };
}
export async function mediaDietReport(userId: string, days = 30) {
  const result = await pool.query<{
    total: string;
    average_reputation: string | null;
    average_signal: string | null;
    public_checks: string;
  }>(
    `SELECT COUNT(*)::text AS total, AVG((tracera_score->'sourceReputation'->>'score')::numeric)::text AS average_reputation, AVG((tracera_score->>'overall')::numeric)::text AS average_signal, COUNT(*) FILTER (WHERE visibility = 'public')::text AS public_checks FROM checks WHERE owner_user_id = $1 AND created_at >= NOW() - ($2 * INTERVAL '1 day')`,
    [userId, days],
  );
  const row = result.rows[0];
  return {
    periodDays: days,
    totalChecks: Number(row?.total ?? 0),
    publicChecks: Number(row?.public_checks ?? 0),
    averageSourceReputation: row?.average_reputation
      ? Math.round(Number(row.average_reputation))
      : null,
    averageSignal: row?.average_signal
      ? Math.round(Number(row.average_signal))
      : null,
  };
}
export async function optedInMediaDietRecipients() {
  const result = await pool.query<{
    id: string;
    email: string;
    frequency: "weekly" | "monthly";
  }>(
    "SELECT users.id, users.email, media_diet_preferences.frequency FROM media_diet_preferences JOIN users ON users.id = media_diet_preferences.user_id WHERE media_diet_preferences.enabled = true",
  );
  return result.rows;
}

/** A prior, sufficiently evidenced claim that can be used as supplementary RAG context. */
export interface RelatedClaim {
  id: string;
  claimText: string;
  verdict: string;
  reasoning: string | null;
  confidence: number | null;
  evidenceQuality: number | null;
  sourceDomain: string | null;
  createdAt: string;
  similarity: number;
}

function toVector(embedding: number[]) {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embeddings must have ${EMBEDDING_DIMENSIONS} dimensions; received ${embedding.length}.`,
    );
  }

  if (!embedding.every(Number.isFinite)) {
    throw new Error("Embedding contains a non-finite value.");
  }

  return `[${embedding.join(",")}]`;
}

/**
 * Retrieves prior Tracera verdicts that are related to (but not necessarily
 * duplicates of) a new claim.  The corpus is deliberately restricted to
 * checkable factual claims with a non-unverified, evidence-backed verdict;
 * raw articles and weak prior answers must never become RAG evidence.
 */
export async function findRelatedClaimsByEmbedding(
  embedding: number[],
  similarityThreshold: number,
  limit: number,
): Promise<RelatedClaim[]> {
  if (similarityThreshold < 0 || similarityThreshold > 1) {
    throw new Error(
      "Related-claim similarity threshold must be between 0 and 1.",
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Related-claim limit must be an integer between 1 and 50.");
  }

  const result = await pool.query<{
    id: string;
    claim_text: string;
    verdict: string;
    reasoning: string | null;
    confidence: string | null;
    evidence_quality: string | null;
    source_domain: string | null;
    created_at: string;
    similarity: number;
  }>(
    `SELECT c.id, c.claim_text, c.verdict, c.reasoning, c.confidence,
            c.evidence_quality, checks.source_domain, checks.created_at,
            1 - (c.embedding <=> $1::vector) AS similarity
       FROM claims AS c
       INNER JOIN checks ON checks.id = c.check_id
      WHERE c.claim_type = 'factual_assertion'
        AND c.checkability IN ('checkable', 'needs_context')
        AND c.verdict IN ('supported', 'contradicted', 'misleading', 'mixed')
        AND c.confidence >= 0.6
        AND c.evidence_quality >= 0.55
        AND 1 - (c.embedding <=> $1::vector) >= $2
      ORDER BY c.embedding <=> $1::vector
      LIMIT $3`,
    [toVector(embedding), similarityThreshold, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    claimText: row.claim_text,
    verdict: row.verdict,
    reasoning: row.reasoning,
    confidence: row.confidence === null ? null : Number(row.confidence),
    evidenceQuality:
      row.evidence_quality === null ? null : Number(row.evidence_quality),
    sourceDomain: row.source_domain,
    createdAt: row.created_at,
    similarity: Number(row.similarity),
  }));
}

/** Finds the closest recent input above the deduplication similarity threshold. */
export async function findRecentCheckByEmbedding(
  embedding: number[],
  similarityThreshold: number,
  maxAgeHours: number,
): Promise<CachedCheck | null> {
  const result = await pool.query<{
    id: string;
    raw_input: string;
    tracera_score: unknown;
    analysis: StoredAnalysis;
    created_at: string;
    expires_at: string;
    similarity: number;
  }>(
    `SELECT id, raw_input, tracera_score, analysis, created_at,
       created_at + ($2 * INTERVAL '1 hour') AS expires_at,
       1 - (embedding <=> $1::vector) AS similarity
     FROM checks
     WHERE created_at >= NOW() - ($2 * INTERVAL '1 hour')
       AND 1 - (embedding <=> $1::vector) >= $3
     ORDER BY embedding <=> $1::vector
     LIMIT 1`,
    [toVector(embedding), maxAgeHours, similarityThreshold],
  );
  const row = result.rows[0];

  return row
    ? {
        id: row.id,
        rawInput: row.raw_input,
        traceraScore: row.tracera_score,
        analysis: row.analysis,
        createdAt: row.created_at,
        similarity: Number(row.similarity),
        expiresAt: row.expires_at,
      }
    : null;
}

/** Reuses only a normalized-identical submission within the configured window. */
export async function findReusableExactCheck(
  rawInput: string,
  maxAgeHours: number,
  ownerUserId?: string,
): Promise<CachedCheck | null> {
  const normalized = rawInput.replace(/\s+/g, " ").trim().toLowerCase();
  const result = await pool.query<{
    id: string;
    raw_input: string;
    tracera_score: unknown;
    analysis: StoredAnalysis;
    created_at: string;
    expires_at: string;
  }>(
    `SELECT id, raw_input, tracera_score, analysis, created_at,
       created_at + ($2 * INTERVAL '1 hour') AS expires_at
       FROM checks
      WHERE created_at >= NOW() - ($2 * INTERVAL '1 hour')
        AND lower(regexp_replace(trim(raw_input), '\\s+', ' ', 'g')) = $1
        AND (visibility = 'public' OR owner_user_id = $3)
      ORDER BY created_at DESC
      LIMIT 1`,
    [normalized, maxAgeHours, ownerUserId ?? null],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        rawInput: row.raw_input,
        traceraScore: row.tracera_score,
        analysis: row.analysis,
        createdAt: row.created_at,
        similarity: 1,
        expiresAt: row.expires_at,
      }
    : null;
}

/** Saves a completed check and the normalized, individually embedded claims atomically. */
export async function persistCheck(input: {
  rawInput: string;
  inputEmbedding: number[];
  traceraScore: unknown;
  analysis: StoredAnalysis;
  claims: StoredClaim[];
  inputType?: string;
  sourceUrl?: string;
  sourceDomain?: string;
  publishedAt?: string;
  groundZero?: unknown;
  prompts?: unknown[];
  ownerUserId?: string;
  visibility?: "public" | "private";
  supersedesCheckId?: string;
}): Promise<{ id: string; createdAt: string }> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const check = await client.query<{ id: string; created_at: string }>(
      `INSERT INTO checks (input_type, raw_input, source_url, source_domain, published_at, embedding, tracera_score, analysis, ground_zero, prompts, owner_user_id, visibility, supersedes_check_id, next_review_at)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, NOW() + INTERVAL '24 hours')
       RETURNING id, created_at`,
      [
        input.inputType ?? "text",
        input.rawInput,
        input.sourceUrl ?? null,
        input.sourceDomain ?? null,
        input.publishedAt ?? null,
        toVector(input.inputEmbedding),
        JSON.stringify(input.traceraScore),
        JSON.stringify(input.analysis),
        JSON.stringify(input.groundZero ?? null),
        JSON.stringify(input.prompts ?? []),
        input.ownerUserId ?? null,
        input.visibility ?? "public",
        input.supersedesCheckId ?? null,
      ],
    );
    const storedCheck = check.rows[0];
    if (!storedCheck) throw new Error("Check insert returned no row.");

    for (const claim of input.claims) {
      await client.query(
        `INSERT INTO claims
          (check_id, claim_text, claim_type, checkability, verdict, confidence, reasoning, evidence_quality, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)`,
        [
          storedCheck.id,
          claim.claimText,
          claim.claimType,
          claim.checkability,
          claim.verdict,
          claim.confidence,
          claim.reasoning.join("\n"),
          claim.evidenceQuality,
          toVector(claim.embedding),
        ],
      );
    }

    await client.query("COMMIT");
    return { id: storedCheck.id, createdAt: storedCheck.created_at };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getTraceTimeline(id: string) {
  const result = await pool.query(
    `WITH RECURSIVE
       ancestors AS (
         SELECT id, supersedes_check_id, tracera_score, created_at
           FROM checks WHERE id = $1
         UNION ALL
         SELECT parent.id, parent.supersedes_check_id, parent.tracera_score, parent.created_at
           FROM checks AS parent
           JOIN ancestors AS child ON child.supersedes_check_id = parent.id
       ),
       root AS (
         SELECT id, supersedes_check_id, tracera_score, created_at
           FROM ancestors
          WHERE supersedes_check_id IS NULL
          LIMIT 1
       ),
       descendants AS (
         SELECT * FROM root
         UNION ALL
         SELECT child.id, child.supersedes_check_id, child.tracera_score, child.created_at
           FROM checks AS child
           JOIN descendants AS parent ON child.supersedes_check_id = parent.id
       )
     SELECT * FROM descendants ORDER BY created_at`,
    [id],
  );
  return result.rows;
}
export async function subscribeToCheck(checkId: string, email: string) {
  const result = await pool.query<{ id: string; active: string }>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, supersedes_check_id FROM checks WHERE id = $1
       UNION ALL
       SELECT parent.id, parent.supersedes_check_id
         FROM checks AS parent JOIN ancestors AS child ON child.supersedes_check_id = parent.id
     ), root AS (
       SELECT id FROM ancestors WHERE supersedes_check_id IS NULL LIMIT 1
     )
     INSERT INTO alert_subscriptions (check_id, email, active, updated_at)
     SELECT id, $2, 'true', NOW() FROM root
     ON CONFLICT (check_id, email)
     DO UPDATE SET active = 'true', updated_at = NOW()
     RETURNING id, active`,
    [checkId, email.toLowerCase()],
  );
  return result.rows[0];
}

export async function unsubscribeFromCheck(checkId: string, email: string) {
  const result = await pool.query<{ id: string }>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, supersedes_check_id FROM checks WHERE id = $1
       UNION ALL SELECT parent.id, parent.supersedes_check_id FROM checks parent JOIN ancestors child ON child.supersedes_check_id = parent.id
     ), root AS (SELECT id FROM ancestors WHERE supersedes_check_id IS NULL LIMIT 1)
     UPDATE alert_subscriptions SET active = 'false', updated_at = NOW()
      WHERE check_id = (SELECT id FROM root) AND email = $2 RETURNING id`,
    [checkId, email.toLowerCase()],
  );
  return result.rows[0] ?? null;
}

export async function alertSubscriptionForCheck(
  checkId: string,
  email: string,
) {
  const result = await pool.query<{ id: string; active: string }>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, supersedes_check_id FROM checks WHERE id = $1
       UNION ALL SELECT parent.id, parent.supersedes_check_id FROM checks parent JOIN ancestors child ON child.supersedes_check_id = parent.id
     ), root AS (SELECT id FROM ancestors WHERE supersedes_check_id IS NULL LIMIT 1)
     SELECT id, active FROM alert_subscriptions WHERE check_id = (SELECT id FROM root) AND email = $2 LIMIT 1`,
    [checkId, email.toLowerCase()],
  );
  return result.rows[0] ?? null;
}

export async function markAlertSubscriptionsNotified(
  checkId: string,
  deliveredCheckId: string,
  emails: string[],
) {
  if (!emails.length) return;
  await pool.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, supersedes_check_id FROM checks WHERE id = $1
       UNION ALL SELECT parent.id, parent.supersedes_check_id FROM checks parent JOIN ancestors child ON child.supersedes_check_id = parent.id
     ), root AS (SELECT id FROM ancestors WHERE supersedes_check_id IS NULL LIMIT 1)
     UPDATE alert_subscriptions SET last_notified_check_id = $2, updated_at = NOW()
      WHERE check_id = (SELECT id FROM root) AND email = ANY($3::text[])`,
    [checkId, deliveredCheckId, emails],
  );
}

export async function activeAlertEmailsForTrace(checkId: string) {
  const result = await pool.query<{ email: string }>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, supersedes_check_id FROM checks WHERE id = $1
       UNION ALL
       SELECT parent.id, parent.supersedes_check_id
         FROM checks AS parent JOIN ancestors AS child ON child.supersedes_check_id = parent.id
     ), root AS (
       SELECT id FROM ancestors WHERE supersedes_check_id IS NULL LIMIT 1
     )
     SELECT DISTINCT email FROM alert_subscriptions
      WHERE check_id = (SELECT id FROM root) AND active = 'true'`,
    [checkId],
  );
  return result.rows.map((row) => row.email);
}
export async function dueChecks(limit = 50) {
  return (
    await pool.query(
      `SELECT id, raw_input, input_type, source_url, analysis FROM checks WHERE next_review_at <= NOW() ORDER BY next_review_at LIMIT $1`,
      [limit],
    )
  ).rows;
}

export async function recordDecayEvent(input: {
  checkId?: string;
  eventType: "scheduled" | "started" | "completed" | "changed" | "failed";
  detail?: unknown;
}) {
  await pool.query(
    `INSERT INTO decay_events (check_id, event_type, detail)
     VALUES ($1, $2, $3::jsonb)`,
    [
      input.checkId ?? null,
      input.eventType,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

export async function getDecayObservability(limit = 100) {
  const result = await pool.query<{
    id: string;
    check_id: string | null;
    event_type: string;
    detail: unknown;
    created_at: string;
  }>(
    `SELECT id, check_id, event_type, detail, created_at
       FROM decay_events
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  );
  return result.rows.map((row) => ({
    id: row.id,
    checkId: row.check_id,
    eventType: row.event_type,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}

export async function listChecks(
  page: number,
  pageSize: number,
  query = "",
  ownerUserId?: string,
) {
  const offset = (page - 1) * pageSize;
  const search = `%${query.trim()}%`;
  const [items, total] = await Promise.all([
    pool.query<{
      id: string;
      raw_input: string;
      tracera_score: unknown;
      created_at: string;
      source_domain: string | null;
      source_url: string | null;
      published_at: string | null;
      next_review_at: string | null;
      visibility: "public" | "private";
    }>(
      `SELECT id, raw_input, tracera_score, created_at, source_domain, source_url, published_at, next_review_at, visibility
       FROM checks
       WHERE raw_input ILIKE $1 AND (visibility = 'public' OR owner_user_id = $4)
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [search, pageSize, offset, ownerUserId ?? null],
    ),
    pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM checks WHERE raw_input ILIKE $1 AND (visibility = 'public' OR owner_user_id = $2)",
      [search, ownerUserId ?? null],
    ),
  ]);

  return {
    checks: items.rows.map((row) => ({
      id: row.id,
      rawInput: snippet(row.raw_input),
      traceraScore: row.tracera_score,
      createdAt: row.created_at,
      sourceDomain: row.source_domain,
      sourceUrl: row.source_url,
      publishedAt: row.published_at,
      visibility: row.visibility,
      reanalysisState:
        row.next_review_at &&
        new Date(row.next_review_at).getTime() <= Date.now()
          ? "review_due"
          : "scheduled",
    })),
    total: Number(total.rows[0]?.count ?? 0),
  };
}

/** Returns a complete stored check, including the original input and structured analysis. */
export async function getCheckById(
  id: string,
  ownerUserId?: string,
  allowPrivate = false,
) {
  const result = await pool.query<{
    id: string;
    raw_input: string;
    tracera_score: unknown;
    analysis: StoredAnalysis;
    created_at: string;
    source_domain: string | null;
    source_url: string | null;
    published_at: string | null;
    ground_zero: unknown;
    next_review_at: string | null;
    visibility: "public" | "private";
    owner_user_id: string | null;
  }>(
    `SELECT id, raw_input, tracera_score, analysis, created_at, source_domain, source_url, published_at, ground_zero, next_review_at, visibility, owner_user_id
     FROM checks
     WHERE id = $1 AND ($3::boolean OR visibility = 'public' OR owner_user_id = $2)
     LIMIT 1`,
    [id, ownerUserId ?? null, allowPrivate],
  );
  const row = result.rows[0];

  return row
    ? {
        id: row.id,
        rawInput: row.raw_input,
        traceraScore: row.tracera_score,
        analysis: row.analysis,
        createdAt: row.created_at,
        sourceDomain: row.source_domain,
        sourceUrl: row.source_url,
        publishedAt: row.published_at,
        groundZero: row.ground_zero,
        nextReviewAt: row.next_review_at,
        visibility: row.visibility,
        ownerUserId: row.owner_user_id,
      }
    : null;
}

/** Used only to refresh a previously analyzed link when the publisher later
 * blocks server-side fetching. Raw input must match exactly. */
export async function findLatestCheckByRawInput(rawInput: string) {
  const result = await pool.query<{ analysis: StoredAnalysis }>(
    `SELECT analysis FROM checks WHERE raw_input = $1 ORDER BY created_at DESC LIMIT 1`,
    [rawInput],
  );
  return result.rows[0]?.analysis ?? null;
}

function snippet(input: string) {
  const normalized = input.replace(/\s+/g, " ").trim();
  return normalized.length <= 280
    ? normalized
    : `${normalized.slice(0, 277)}...`;
}

export async function checkDatabase() {
  const result = await pool.query<{ connected: number }>(
    "SELECT 1 AS connected",
  );

  return result.rows[0]?.connected === 1 ? "connected" : "unavailable";
}

export async function getDomainTrustScores(domains: string[]) {
  const unique = [...new Set(domains.filter(Boolean))];
  if (!unique.length) return new Map<string, number>();
  const result = await pool.query<{ domain: string; trust_score: string }>(
    "SELECT domain, trust_score FROM domains WHERE domain = ANY($1::text[])",
    [unique],
  );
  return new Map(
    result.rows.map((row) => [row.domain, Number(row.trust_score)]),
  );
}
