-- Keep semantic RAG lookup fast as the verified-claim corpus grows.
-- HNSW works for incremental inserts, unlike IVF indexes that need periodic rebuilds.
CREATE INDEX IF NOT EXISTS "claims_embedding_hnsw_idx"
  ON "claims" USING hnsw ("embedding" vector_cosine_ops);

-- These predicates mirror the eligibility gate used by findRelatedClaimsByEmbedding.
CREATE INDEX IF NOT EXISTS "claims_rag_eligibility_idx"
  ON "claims" ("claim_type", "checkability", "verdict")
  WHERE "confidence" >= 0.6 AND "evidence_quality" >= 0.55;
