import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export const EMBEDDING_DIMENSIONS = 1024;

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://localhost:5432/tracera";

export const pool = new Pool({ connectionString });
export const db = drizzle(pool);

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
    similarity: number;
  }>(
    `SELECT id, raw_input, tracera_score, analysis, created_at,
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
  supersedesCheckId?: string;
}): Promise<{ id: string; createdAt: string }> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const check = await client.query<{ id: string; created_at: string }>(
      `INSERT INTO checks (input_type, raw_input, source_url, source_domain, published_at, embedding, tracera_score, analysis, ground_zero, prompts, owner_user_id, supersedes_check_id, next_review_at)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, NOW() + INTERVAL '24 hours')
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
  const result = await pool.query<{ id: string }>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, supersedes_check_id FROM checks WHERE id = $1
       UNION ALL
       SELECT parent.id, parent.supersedes_check_id
         FROM checks AS parent JOIN ancestors AS child ON child.supersedes_check_id = parent.id
     ), root AS (
       SELECT id FROM ancestors WHERE supersedes_check_id IS NULL LIMIT 1
     )
     INSERT INTO alert_subscriptions (check_id, email)
     SELECT id, $2 FROM root
     RETURNING id`,
    [checkId, email.toLowerCase()],
  );
  return result.rows[0];
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

export async function listChecks(page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const [items, total] = await Promise.all([
    pool.query<{
      id: string;
      raw_input: string;
      tracera_score: unknown;
      created_at: string;
    }>(
      `SELECT id, raw_input, tracera_score, created_at
       FROM checks
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    ),
    pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM checks"),
  ]);

  return {
    checks: items.rows.map((row) => ({
      id: row.id,
      rawInput: snippet(row.raw_input),
      traceraScore: row.tracera_score,
      createdAt: row.created_at,
    })),
    total: Number(total.rows[0]?.count ?? 0),
  };
}

/** Returns a complete stored check, including the original input and structured analysis. */
export async function getCheckById(id: string) {
  const result = await pool.query<{
    id: string;
    raw_input: string;
    tracera_score: unknown;
    analysis: StoredAnalysis;
    created_at: string;
  }>(
    `SELECT id, raw_input, tracera_score, analysis, created_at
     FROM checks
     WHERE id = $1
     LIMIT 1`,
    [id],
  );
  const row = result.rows[0];

  return row
    ? {
        id: row.id,
        rawInput: row.raw_input,
        traceraScore: row.tracera_score,
        analysis: row.analysis,
        createdAt: row.created_at,
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
