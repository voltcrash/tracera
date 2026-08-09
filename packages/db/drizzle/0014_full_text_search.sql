ALTER TABLE "checks" ADD COLUMN "search_document" tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce("raw_input", '') || ' ' || coalesce("source_domain", '')
    )
  ) STORED;

ALTER TABLE "claims" ADD COLUMN "search_document" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("claim_text", ''))) STORED;

CREATE INDEX "checks_search_document_idx"
  ON "checks" USING gin ("search_document");
CREATE INDEX "claims_search_document_idx"
  ON "claims" USING gin ("search_document");
