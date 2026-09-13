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

test("related claims only ever come from the requesting user's own checks", async () => {
  const records = [
    relatedClaim("unowned-claim", null),
    relatedClaim("user-a-claim", USER_A),
    relatedClaim("user-b-claim", USER_B),
  ];

  const result = await withPoolQuery(
    async (text, params = []) => {
      assert.match(text, /AND checks\.owner_user_id = \$4/);
      assert.doesNotMatch(text, /visibility/);
      const ownerUserId = params[3];
      return {
        rows: records
          .filter((record) => record.ownerUserId === ownerUserId)
          .map(({ ownerUserId: _ownerUserId, ...row }) => row),
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

  assert.deepEqual(result, { userA: ["user-a-claim"], userB: ["user-b-claim"] });
});

test("cached URL analyses only ever come from the requesting user's own checks", async () => {
  const userAAnalysis = analysis("user A analysis");
  const userBAnalysis = analysis("user B analysis");
  const records = [
    { ownerUserId: null, analysis: analysis("unowned analysis") },
    { ownerUserId: USER_A, analysis: userAAnalysis },
    { ownerUserId: USER_B, analysis: userBAnalysis },
  ] as const;

  const result = await withPoolQuery(
    async (text, params = []) => {
      assert.match(text, /AND owner_user_id = \$2/);
      assert.doesNotMatch(text, /visibility/);
      const ownerUserId = params[1];
      const record = records.filter((candidate) => candidate.ownerUserId === ownerUserId).at(-1);
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

function relatedClaim(id: string, ownerUserId: string | null) {
  return {
    id,
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
