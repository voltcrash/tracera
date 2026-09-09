# Environment configuration

Tracera uses one local environment file at the repository root. Copy
`.env.example` to `.env`, then add an optional value only when enabling its
feature. The web app, database tooling, and AI scripts all load this root file.
All environment configuration is server-only; the browser bundle does not
require environment variables.

## Core values

- `DATABASE_URL` — Neon/PostgreSQL connection string for the least-privileged
  `tracera_runtime` role. This is the only database URL the web app should
  receive.
- `DATABASE_MIGRATOR_URL` — owner-role connection string used only by Drizzle
  migrations. Keep it out of Vercel runtime environment variables and store it
  only in the operator's migration environment.
- `BETTER_AUTH_SECRET` — secret used to sign Better Auth sessions.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` — Google OAuth credentials.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` — credentials from the Tracera
  GitHub App. Use a GitHub App, not a GitHub OAuth App.
- `AI_PROVIDER` — `gemini`, `openai`, `openrouter`, `anthropic`, or
  `openai-compatible`.
- `AI_API_KEY` — key for the selected generation provider.

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

## Operational settings

These are only needed for administration:

- `BETTER_AUTH_API_KEY` — optional Better Auth dashboard integration.
- `DOMAIN_TRUST_AUTO_REFINE` and `DOMAIN_TRUST_ADMIN_TOKEN` — domain trust
  review controls.

Analysis thresholds, story-reuse policy, embedding dimensions, site origins,
and model-evaluation thresholds are application behavior rather than deployment
configuration. They are defined in code. Model-evaluation overrides are passed
as command-line options documented in `packages/ai/evaluation/README.md`.

## Database roles and row-level security

Migration `0020_least_privileged_runtime_role.sql` creates a non-owner,
`NOBYPASSRLS` login role named `tracera_runtime`. It removes public and runtime
access to the schema, tables, sequences, and future table/sequence objects,
then grants only the operations currently required by the web app:

- Better Auth tables: `SELECT`, `INSERT`, `UPDATE`, and `DELETE`.
- `checks`, `claims`, and `trace_appearances`: `SELECT` and `INSERT`.
- `domains`: `SELECT`, `INSERT`, and `UPDATE`.
- `domain_trust_events`: `SELECT` and `INSERT`.

The runtime role has no access grant for the unused `alert_subscriptions`,
`decay_events`, or migration metadata tables. Set its password through the
database provider or a secret manager; passwords must not be added to the
migration file.

Run migrations with the owner URL, for example:

```sh
DATABASE_MIGRATOR_URL=... vp run --filter @repo/db db:migrate
```

Forced row-level security was evaluated for `checks` and its user-owned child
data. It is not enabled by this migration because the current server passes the
authenticated user ID as a SQL parameter while using a shared, stateless Neon
pool; it does not establish a transaction-local database identity. Enabling
`FORCE ROW LEVEL SECURITY` without that identity bridge would make private
checks inaccessible or risk stale pooled identity state. A future RLS change
must add fail-closed policies for every table containing user-owned data,
bind `app.user_id` with `set_config(..., true)` inside each transaction, and
prove that public reads, anonymous rows, Better Auth, and multi-statement
transactions all behave correctly before enabling `FORCE`.
