DROP INDEX IF EXISTS "checks_search_document_idx";

ALTER TABLE "checks" DROP COLUMN "search_document";

ALTER TABLE "checks" ADD COLUMN "search_document" tsvector
  GENERATED ALWAYS AS (
    CASE
      -- Image raw_input values are base64 data URIs. The extracted claims are
      -- indexed separately and are the meaningful searchable representation.
      WHEN "input_type" = 'image' THEN
        to_tsvector('english', coalesce("source_domain", ''))
      ELSE
        -- PostgreSQL rejects oversized tsvector input. This bound is below the
        -- byte limit even when every character uses four UTF-8 bytes.
        to_tsvector(
          'english',
          left(
            coalesce("raw_input", '') || ' ' || coalesce("source_domain", ''),
            200000
          )
        )
    END
  ) STORED;

CREATE INDEX "checks_search_document_idx"
  ON "checks" USING gin ("search_document");
