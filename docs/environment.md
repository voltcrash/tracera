# Environment configuration

The web app needs six core values. Start with `apps/web/.env.example`; the
settings below are optional and should only be added when the related feature
is enabled.

## Core values

- `DATABASE_URL` — Neon/PostgreSQL connection string.
- `BETTER_AUTH_SECRET` — secret used to sign Better Auth sessions.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` — Google OAuth credentials.
- `AI_PROVIDER` — `gemini`, `openai`, `openrouter`, `anthropic`, or
  `openai-compatible`.
- `AI_API_KEY` — key for the selected generation provider.

## AI provider overrides

Gemini uses built-in model defaults, including 1024-dimensional embeddings.
For other providers, add only what is needed:

- `AI_MODEL` — generation model override.
- `AI_EMBEDDING_MODEL` — embedding model for OpenAI-compatible providers.
- `AI_EMBEDDING_DIMENSIONS` — embedding size; defaults to `1024`.
- `AI_BASE_URL` — required when `AI_PROVIDER=openai-compatible`.
- `AI_EMBEDDING_PROVIDER` — separate embedding provider, required for
  Anthropic generation.
- `AI_EMBEDDING_API_KEY` and `AI_EMBEDDING_BASE_URL` — overrides for that
  separate embedding provider.

## Optional integrations

- `NEXT_PUBLIC_SITE_URL` — canonical site URL; defaults to the deployed
  Tracera URL.
- `WEB_ORIGIN` — comma-separated additional browser origins for CORS.
- `PUBLIC_API_KEYS` — enables the API-key-protected public API. The legacy
  `PUBLIC_API_KEY` name is also accepted.
- `GOOGLE_FACT_CHECK_API_KEY`, `NEWS_API_KEY`, `WEB_SEARCH_ENDPOINT`, and
  `WEB_SEARCH_API_KEY` — additional evidence retrieval providers.
- `OCR_ENDPOINT` and `OCR_API_KEY` — external OCR for image submissions.
- `REVERSE_IMAGE_SEARCH_ENDPOINT` and `REVERSE_IMAGE_SEARCH_API_KEY` —
  external reverse-image search for image provenance.

## Operational settings

These are only needed for administration or scheduled delivery:

- `BETTER_AUTH_API_KEY`, `BETTER_AUTH_API_URL`, and `BETTER_AUTH_KV_URL` —
  optional Better Auth dashboard integration.
- `DOMAIN_TRUST_AUTO_REFINE` and `DOMAIN_TRUST_ADMIN_TOKEN` — domain trust
  review controls.
- `INTERNAL_WORKER_TOKEN` — authorizes internal maintenance requests.
- `RESEND_API_KEY` and `ALERT_FROM_EMAIL` — email delivery configuration.

The analysis and story-reuse thresholds have safe code defaults and do not
need to be configured. The AI evaluation scripts also accept optional
`EVAL_*` overrides; they are not required by the deployed app.
