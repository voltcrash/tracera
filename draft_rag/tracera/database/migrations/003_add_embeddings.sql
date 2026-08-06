-- Phase 3: local sentence-transformer embeddings stored with pgvector.
-- This migration adds new columns only; it never changes ingestion or
-- preprocessing data.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS embedding vector(384),
    ADD COLUMN IF NOT EXISTS embedding_model TEXT,
    ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS embedding_version VARCHAR(50);

-- Supports operational reporting and re-embedding selected model versions.
CREATE INDEX IF NOT EXISTS idx_articles_embedding_model
    ON articles (embedding_model)
    WHERE embedding IS NOT NULL;

-- Prefer HNSW: it provides fast approximate nearest-neighbour retrieval and
-- does not need a preconfigured list count. Older pgvector installations that
-- do not provide HNSW fall back to the broadly-supported IVFFLAT index.
DO $$
BEGIN
    CREATE INDEX IF NOT EXISTS idx_articles_embedding_hnsw_cosine
        ON articles
        USING hnsw (embedding vector_cosine_ops)
        WHERE embedding IS NOT NULL;
EXCEPTION
    WHEN undefined_object OR feature_not_supported THEN
        RAISE NOTICE 'HNSW is unavailable; creating an IVFFLAT cosine index instead.';
        CREATE INDEX IF NOT EXISTS idx_articles_embedding_ivfflat_cosine
            ON articles
            USING ivfflat (embedding vector_cosine_ops)
            WITH (lists = 100)
            WHERE embedding IS NOT NULL;
END $$;
