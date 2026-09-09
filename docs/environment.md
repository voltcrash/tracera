# Environment configuration

Tracera uses one local environment file at the repository root. Copy
`.env.example` to `.env`, then add an optional value only when enabling its
feature. The web app, database tooling, and AI scripts all load this root file.
All environment configuration is server-only; the browser bundle does not
require environment variables.

## Core values

- `DATABASE_URL` — Neon/PostgreSQL connection string.
- `BETTER_AUTH_SECRET` — secret used to sign Better Auth sessions.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` — Google OAuth credentials.
- `AI_PROVIDER` — `gemini`, `openai`, `openrouter`, `anthropic`, or
  `openai-compatible`.
- `AI_API_KEY` — key for the selected generation provider.

## Development authentication

- `DEV_AUTH_BYPASS` — set to exactly `true` to enable
  `GET /api/auth/dev-login` while `NODE_ENV=development`. On a loopback host,
  the endpoint creates or loads `developer@tracera.local`, creates a real
  database-backed Better Auth session, sets its normal session cookie, and
  redirects to `/home`. The route is not registered in any other environment.

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

- `GOOGLE_FACT_CHECK_API_KEY` and `NEWS_API_KEY` — additional evidence
  retrieval providers.

## Operational settings

These are only needed for administration:

- `BETTER_AUTH_API_KEY` — optional Better Auth dashboard integration.
- `DOMAIN_TRUST_AUTO_REFINE` and `DOMAIN_TRUST_ADMIN_TOKEN` — domain trust
  review controls.

Analysis thresholds, story-reuse policy, embedding dimensions, site origins,
and model-evaluation thresholds are application behavior rather than deployment
configuration. They are defined in code. Model-evaluation overrides are passed
as command-line options documented in `packages/ai/evaluation/README.md`.
