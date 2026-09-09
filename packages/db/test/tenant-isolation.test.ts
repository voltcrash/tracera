import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  findLatestCheckByRawInput,
  findRelatedClaimsByEmbedding,
  pool,
  type StoredAnalysis,
} from "../src/index.js";

const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const embedding = Array.from({ length: 1024 }, () => 0);

type QueryResult = { rows: unknown[] };
type QueryStub = (text: string, params?: unknown[]) => Promise<QueryResult>;

async function withPoolQuery<T>(query: QueryStub, run: () => Promise<T>) {
  const queryablePool = pool as unknown as { query: QueryStub };
  const originalQuery = queryablePool.query;
  queryablePool.query = query;
  try {
    return await run();
  } finally {
    queryablePool.query = originalQuery;
  }
}

test("related claims include public and only the requesting user's private claims", async () => {
  const records = [
    relatedClaim("public-claim", "public", null),
    relatedClaim("user-a-claim", "private", USER_A),
    relatedClaim("user-b-claim", "private", USER_B),
  ];

  const result = await withPoolQuery(
    async (text, params = []) => {
      assert.match(text, /AND \(checks\.visibility = 'public' OR checks\.owner_user_id = \$4\)/);
      const ownerUserId = params[3];
      return {
        rows: records
          .filter((record) => record.visibility === "public" || record.ownerUserId === ownerUserId)
          .map(({ visibility: _visibility, ownerUserId: _ownerUserId, ...row }) => row),
      };
    },
    async () => {
      const [userAClaims, userBClaims] = await Promise.all([
        findRelatedClaimsByEmbedding(embedding, 0.78, 5, USER_A),
        findRelatedClaimsByEmbedding(embedding, 0.78, 5, USER_B),
      ]);
      return {
        userA: userAClaims.map((claim) => claim.id),
        userB: userBClaims.map((claim) => claim.id),
      };
    },
  );

  assert.deepEqual(result, {
    userA: ["public-claim", "user-a-claim"],
    userB: ["public-claim", "user-b-claim"],
  });
});

test("cached URL analyses include public and only the requesting user's private analysis", async () => {
  const publicAnalysis = analysis("public analysis");
  const userAAnalysis = analysis("user A analysis");
  const userBAnalysis = analysis("user B analysis");
  const records = [
    { visibility: "public", ownerUserId: null, analysis: publicAnalysis },
    { visibility: "private", ownerUserId: USER_A, analysis: userAAnalysis },
    { visibility: "private", ownerUserId: USER_B, analysis: userBAnalysis },
  ] as const;

  const result = await withPoolQuery(
    async (text, params = []) => {
      assert.match(text, /AND \(visibility = 'public' OR owner_user_id = \$2\)/);
      const ownerUserId = params[1];
      const record = records
        .filter(
          (candidate) => candidate.visibility === "public" || candidate.ownerUserId === ownerUserId,
        )
        .at(-1);
      return { rows: record ? [{ analysis: record.analysis }] : [] };
    },
    async () => {
      const [userAAnalysisResult, userBAnalysisResult] = await Promise.all([
        findLatestCheckByRawInput("https://example.com/story", USER_A),
        findLatestCheckByRawInput("https://example.com/story", USER_B),
      ]);
      return {
        userA: userAAnalysisResult?.claims,
        userB: userBAnalysisResult?.claims,
      };
    },
  );

  assert.deepEqual(result, {
    userA: userAAnalysis.claims,
    userB: userBAnalysis.claims,
  });
});

function relatedClaim(id: string, visibility: "public" | "private", ownerUserId: string | null) {
  return {
    id,
    visibility,
    ownerUserId,
    claim_text: `${id} text`,
    verdict: "supported",
    reasoning: `${id} reasoning`,
    confidence: "0.9",
    evidence_quality: "0.8",
    source_domain: "example.com",
    created_at: "2026-09-09T00:00:00.000Z",
    similarity: 0.9,
  };
}

function analysis(claimText: string): StoredAnalysis {
  return { claims: [claimText], score: null };
}
