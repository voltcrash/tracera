ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS processed_content TEXT,
    ADD COLUMN IF NOT EXISTS normalized_content TEXT,
    ADD COLUMN IF NOT EXISTS detected_language VARCHAR(10),
    ADD COLUMN IF NOT EXISTS language_confidence NUMERIC(5, 4),
    ADD COLUMN IF NOT EXISTS word_count INTEGER,
    ADD COLUMN IF NOT EXISTS sentence_count INTEGER,
    ADD COLUMN IF NOT EXISTS paragraph_count INTEGER,
    ADD COLUMN IF NOT EXISTS character_count INTEGER,
    ADD COLUMN IF NOT EXISTS reading_time_minutes NUMERIC(6, 2),
    ADD COLUMN IF NOT EXISTS summary TEXT,
    ADD COLUMN IF NOT EXISTS keywords JSONB,
    ADD COLUMN IF NOT EXISTS is_valid BOOLEAN,
    ADD COLUMN IF NOT EXISTS validation_reason TEXT,
    ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_articles_is_valid
    ON articles (is_valid);

CREATE INDEX IF NOT EXISTS idx_articles_detected_language
    ON articles (detected_language);

CREATE INDEX IF NOT EXISTS idx_articles_processed_at
    ON articles (processed_at);