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
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` — credentials from the Tracera
  GitHub App. Use a GitHub App, not a GitHub OAuth App.
- `AI_PROVIDER` — `gemini`, `openai`, `openrouter`, `anthropic`, or
  `openai-compatible`.
- `AI_API_KEY` — key for the selected generation provider.

## OAuth token storage

Tracera uses provider tokens only while completing an OAuth callback. Better
Auth encryption remains enabled as defense in depth, while account hooks drop
access, refresh, and ID tokens before an account is written or updated. Apply
the database migrations with `vp run --filter @repo/db db:migrate`; migration
`0020_clear_oauth_tokens.sql` removes token material created before this policy.

If a previous database, backup, or log may have exposed provider tokens, revoke
the old Google and GitHub grants in their provider consoles. Clearing the
database cannot invalidate a token that was copied elsewhere.

## GitHub authentication

Create a GitHub App under the owning account's developer settings with these
values:

- GitHub App name: `Tracera` (or another globally unique Tracera name).
- Homepage URL: `https://tracera.voltcrash.com`.
- Callback URLs:
  - `http://localhost:3000/api/auth/callback/github`
  - `https://tracera.voltcrash.com/api/auth/callback/github`
- Wildcard matching for both callback URLs: disabled.
- Webhooks: inactive.
- Request user authorization during installation: disabled.
- Device flow: disabled; setup URL: blank.
- Account permissions: **Email addresses — Read-only**.
- Repository and organization permissions: none.
- Installation availability: **Any account**.

No installation flow, private key, or installation token is used. Copy the
GitHub App's client ID and generate one client secret. Store them only as
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in the root `.env` for local
development and as encrypted environment variables in the Vercel project for
production. Never commit their real values.

Both GitHub variables must be set together. Until they are present, Google
authentication continues to work and GitHub attempts use the normal
provider-unavailable error flow.

Better Auth requests GitHub's user and email scopes and stores GitHub's stable
numeric user ID as the provider account ID. Account linking requires the same
verified email address; mutable GitHub usernames and email addresses are not
used as provider identity keys.

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

## Analysis safeguards

Both `/api/tracera/analyze` and `/api/tracera/analyze/stream` require an
`Idempotency-Key` header. Reusing a key with the same request replays the
stored response; reusing it for a different request is rejected. The browser
client creates a key for each submission.

Analysis admission is coordinated in Postgres, so limits apply across all
serverless instances. The defaults are 30 requests per user and 60 per IP per
hour, two concurrent analyses per user, four per IP, and 100 admitted requests
per user per UTC day. Forced reanalysis of the same submission has a one-hour
cooldown. Leases expire after ten minutes so abandoned requests cannot hold a
concurrency slot forever.

These settings can be overridden in the server environment:

- `ANALYSIS_USER_RATE_LIMIT`, `ANALYSIS_IP_RATE_LIMIT`, and
  `ANALYSIS_RATE_WINDOW_SECONDS` control the distributed fixed-window rates.
- `ANALYSIS_USER_CONCURRENCY_LIMIT`, `ANALYSIS_IP_CONCURRENCY_LIMIT`, and
  `ANALYSIS_LEASE_SECONDS` control distributed in-flight leases.
- `ANALYSIS_DAILY_QUOTA` and
  `ANALYSIS_FORCE_REANALYSIS_COOLDOWN_SECONDS` control per-user daily usage and
  forced reanalysis.
- `ANALYSIS_IDEMPOTENCY_TTL_SECONDS` controls how long completed responses are
  replayable.
- `AI_DAILY_SPEND_LIMIT_USD` opens a per-provider daily spend circuit. Since
  provider adapters do not all return billable token usage, the circuit uses
  conservative per-request estimates configured with
  `AI_ESTIMATED_GENERATION_COST_USD`, `AI_ESTIMATED_IMAGE_COST_USD`, and
  `AI_ESTIMATED_EMBEDDING_COST_USD`. Reservations are settled even when a
  provider call fails.

## Operational settings

These are only needed for administration:

- `DOMAIN_TRUST_AUTO_REFINE` and `DOMAIN_TRUST_ADMIN_TOKEN` — domain trust
  review controls.

Analysis thresholds, story-reuse policy, embedding dimensions, site origins,
and model-evaluation thresholds are application behavior rather than deployment
configuration. They are defined in code. Model-evaluation overrides are passed
as command-line options documented in `packages/ai/evaluation/README.md`.
