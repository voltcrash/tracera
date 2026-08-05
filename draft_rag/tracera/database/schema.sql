-- database/schema.sql
--
-- Phase 1 schema: article metadata storage only.
--
-- NOTE: pgvector and the `chunks`/`embeddings` tables are intentionally
-- NOT created here — that's Phase 5. This schema exists so article
-- metadata (title, url, publisher, dates, dedup hash) is queryable from
-- day one, without waiting on the vector pipeline to exist.

CREATE TABLE IF NOT EXISTS articles (
    id              SERIAL PRIMARY KEY,
    url             TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    publisher       TEXT NOT NULL,
    source_type     VARCHAR(20) NOT NULL,       -- 'rss' or 'gdelt'
    category        TEXT,
    language        VARCHAR(10),

    published_at    TIMESTAMPTZ,
    collected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    content_hash    VARCHAR(64) NOT NULL UNIQUE, -- sha256 hex digest, for dedup
    cleaned_text    TEXT,                        -- Phase-1-level cleaned body
    raw_json_path   TEXT,                        -- path to the JSON batch file this article was written into

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookups by dedup hash happen on every ingestion run.
CREATE INDEX IF NOT EXISTS idx_articles_content_hash ON articles (content_hash);

-- Phase 6 will filter by these frequently.
CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles (published_at);
CREATE INDEX IF NOT EXISTS idx_articles_publisher ON articles (publisher);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles (category);
CREATE INDEX IF NOT EXISTS idx_articles_source_type ON articles (source_type);
