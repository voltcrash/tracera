# Environment configuration

The web app needs six values. All environment configuration is server-only;
the browser bundle does not require environment variables. Start with
`apps/web/.env.example` and add an optional value only when enabling its feature.

## Core values

- `DATABASE_URL` — Neon/PostgreSQL connection string.
- `BETTER_AUTH_SECRET` — secret used to sign Better Auth sessions.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` — Google OAuth credentials.
- `AI_PROVIDER` — `gemini`, `openai`, `openrouter`, `anthropic`, or
  `openai-compatible`.
- `AI_API_KEY` — key for the selected generation provider.

## AI provider overrides

Gemini uses built-in generation and embedding defaults. Tracera stores
1024-dimensional embeddings for every provider. For other providers, add only
what is needed:

- `AI_MODEL` — generation model override.
- `AI_EMBEDDING_MODEL` — embedding model for OpenAI-compatible providers.
- `AI_BASE_URL` — required when `AI_PROVIDER=openai-compatible`.
- `AI_EMBEDDING_PROVIDER` — separate embedding provider, required for
  Anthropic generation.
- `AI_EMBEDDING_API_KEY` and `AI_EMBEDDING_BASE_URL` — overrides for that
  separate embedding provider.

## Optional integrations

- `PUBLIC_API_KEYS` — comma- or newline-separated keys that enable the
  API-key-protected public API.
- `GOOGLE_FACT_CHECK_API_KEY`, `NEWS_API_KEY`, `WEB_SEARCH_ENDPOINT`, and
  `WEB_SEARCH_API_KEY` — additional evidence retrieval providers.
- `REVERSE_IMAGE_SEARCH_ENDPOINT` and `REVERSE_IMAGE_SEARCH_API_KEY` —
  external reverse-image search for image provenance.

## Operational settings

These are only needed for administration or scheduled delivery:

- `BETTER_AUTH_API_KEY` — optional Better Auth dashboard integration.
- `DOMAIN_TRUST_AUTO_REFINE` and `DOMAIN_TRUST_ADMIN_TOKEN` — domain trust
  review controls.
- `INTERNAL_WORKER_TOKEN` — authorizes internal maintenance requests.
- `RESEND_API_KEY` and `ALERT_FROM_EMAIL` — email delivery configuration.

Analysis thresholds, story-reuse policy, embedding dimensions, site origins,
and model-evaluation thresholds are application behavior rather than deployment
configuration. They are defined in code. Model-evaluation overrides are passed
as command-line options documented in `packages/ai/evaluation/README.md`.
