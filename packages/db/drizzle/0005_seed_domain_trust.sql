-- Conservative bootstrap values for primary institutions and major wire/public
-- broadcasters frequently returned by the initial retrieval adapters. These
-- are only defaults: operator-curated values in `domains` remain the source
-- of truth and may be adjusted as Tracera's outcome data accumulates.
INSERT INTO "domains" ("domain", "trust_score") VALUES
  ('apnews.com', 0.85),
  ('bbc.com', 0.85),
  ('bbc.co.uk', 0.85),
  ('cdc.gov', 0.95),
  ('climate.gov', 0.95),
  ('esa.int', 0.95),
  ('fda.gov', 0.95),
  ('gov.uk', 0.90),
  ('ipcc.ch', 0.95),
  ('nasa.gov', 0.95),
  ('npr.org', 0.85),
  ('reuters.com', 0.85),
  ('science.nasa.gov', 0.95),
  ('who.int', 0.95)
ON CONFLICT ("domain") DO NOTHING;
