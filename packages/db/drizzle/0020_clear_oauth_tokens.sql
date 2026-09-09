-- Tracera only uses provider credentials during the OAuth callback. Existing
-- credentials are discarded because the application has no provider API path
-- that needs to read them after sign-in.
UPDATE "accounts"
SET "access_token" = NULL,
    "refresh_token" = NULL,
    "id_token" = NULL,
    "access_token_expires_at" = NULL,
    "refresh_token_expires_at" = NULL
WHERE "access_token" IS NOT NULL
   OR "refresh_token" IS NOT NULL
   OR "id_token" IS NOT NULL
   OR "access_token_expires_at" IS NOT NULL
   OR "refresh_token_expires_at" IS NOT NULL;
