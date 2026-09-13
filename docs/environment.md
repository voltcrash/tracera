# Environment configuration

Tracera selects an explicit profile and process role independently of `NODE_ENV`. Root `.env` files are not loaded. Local and test commands use generated, worktree-specific files; deployed commands use only their process environment.

Profiles:

- `local` — development application and persistent development database target.
- `test` — deterministic tests and disposable test-database targets.
- `deployed` — hosted runtime, operator migrations, and explicitly authorized live AI scripts.

Roles:

- `runtime` receives `DATABASE_URL` and application settings, never migrator or test-provisioner credentials.
- `migration` receives only `DATABASE_MIGRATOR_URL` from the database settings.
- `test-provisioning` receives only `TEST_DATABASE_PROVISIONER_URL` and is unavailable with the deployed profile.
- `analysis` receives no database URL. Local/test analysis also rejects external provider credentials and endpoints.

The profile is not inferred from `NODE_ENV`. Consequently, `vp run build` is a production-mode Next build that still uses the selected local profile and local target. Hosted builds must set `TRACERA_PROFILE=deployed` and `TRACERA_CONFIG_ROLE=runtime` explicitly.

## Local and test setup

Run:

```sh
vp run env:setup
vp run env:diagnose:local
```

Setup derives a stable identifier and port from the current worktree path, creates strong random local passwords and a Better Auth secret, and writes mode-0600 files under ignored `.tracera/environment/local` and `.tracera/environment/test` directories. It does not read or copy any legacy environment file. Existing generated files are retained, so rerunning setup does not rotate database credentials unexpectedly.

The committed shape is documented in `config/environment/local.generated.env.example`; never copy its placeholders. L02 will make the generated database targets real. Until then, `vp run dev` and `vp run db:migrate:local` pass configuration validation but fail safely when they reach the unprovisioned loopback PostgreSQL target. L01 does not provide a working database, credential-free sign-in, or offline application analysis.

## Loading and precedence

The launcher reads exactly two files, in order:

1. `.tracera/environment/<profile>/shared.env`
2. `.tracera/environment/<profile>/<role>.env`

Keys cannot appear in both files; duplicates are errors rather than overrides. Profile and role markers are launcher-owned and cannot appear in either file. Unknown managed keys are rejected.

Before loading local/test files, the launcher rejects:

- inherited Tracera database, auth, provider, or profile variables;
- `.env` or `.env.*` files (other than `.env.example`) in the repository root, `apps/web`, or the `ai`, `auth`, and `db` packages, because Next.js and older scripts load them implicitly;
- missing generated files.

After loading, it seals the selected values. Import-time and connection-entry validation detects role changes, injected managed values, or modifications to the selected target before a database connection opens. Diagnostics report only the profile, role, database username, loopback host, port, and database name; passwords, secrets, tokens, and query parameters are never displayed.

This fail-closed policy means exported production variables do not override local values. Unset them before launching a local/test command; do not paste them into generated files.

## Local target validation

Local/test database URLs must:

- use `postgresql:` or `postgres:`;
- use `localhost`, `127.0.0.1`, or `::1`;
- match the generated worktree host, port, and database name;
- use `tracera_runtime`, `tracera_migrator`, or `tracera_test_provisioner` according to the selected role.

`CORE_STORAGE_TEST_DATABASE_URL` is accepted only by the `test` profile's runtime role. It must satisfy the same rules as the runtime URL, except that its database name must be a disposable database prefixed with the generated test database name (`<name>_<run>`). The Core storage integration test validates it before opening a pool; setting it without the test profile fails instead of connecting. The provisioning runner that creates such databases belongs to L03.

Local/test profiles reject OAuth client secrets, AI credentials and custom endpoints, and optional paid retrieval credentials. There is no external fallback. L04 will add local Better Auth login behavior, and L05 will add deterministic AI and retrieval fixtures.

## Deployed configuration

Deployment examples are split by role:

- `config/environment/deployed.runtime.env.example`
- `config/environment/deployed.migration.env.example`
- `config/environment/deployed.analysis.env.example`

**Deployment prerequisite.** `next.config.js`, the request proxy, and database configuration now fail closed when Tracera settings are present without a profile. Before deploying this change, the hosted web environment (build and runtime) must set `TRACERA_PROFILE=deployed` and `TRACERA_CONFIG_ROLE=runtime`, and must not contain `DATABASE_MIGRATOR_URL`, `TEST_DATABASE_PROVISIONER_URL`, or `CORE_STORAGE_TEST_DATABASE_URL`.

Do not combine them. The web deployment should receive the runtime example's settings only. The operator migration environment should receive the migration example's settings only. AI validation scripts are live-capable only under an explicitly selected and valid environment; local/test profiles reject their credentials before the script runs.

Core deployed values include:

- `DATABASE_URL` — the least-privileged `tracera_runtime` connection.
- `BETTER_AUTH_SECRET` — the Better Auth signing secret.
- paired Google credentials and optional paired GitHub credentials.
- `AI_PROVIDER`, `AI_API_KEY`, and only the model/base URL/embedding overrides required by that provider.
- optional `GOOGLE_FACT_CHECK_API_KEY` and `NEWS_API_KEY` retrieval credentials.

Run operator migrations only from an environment containing:

```sh
TRACERA_PROFILE=deployed
TRACERA_CONFIG_ROLE=migration
DATABASE_MIGRATOR_URL=postgresql://OWNER:REDACTED@HOST/DATABASE
```

Then run `vp run @repo/db#db:migrate`. Never add `DATABASE_MIGRATOR_URL` to the web process.

## Retiring a shared root `.env`

If any of those environment files exist, do not print it, source it, copy it into `.tracera`, or delete it automatically. Move it to a secure location outside the repository, then inventory and rotate its credentials through the relevant provider or secret manager. Generate local/test configuration with `vp run env:setup`; do not reuse production values locally.

After deployment settings have been transferred to the role-specific secret stores, remove the old root file yourself through an approved recoverable workflow. The launcher checks only for its filename and never reads its contents.

## OAuth token storage

Tracera uses provider tokens only while completing an OAuth callback. Better
Auth encryption remains enabled as defense in depth, while account hooks drop
access, refresh, and ID tokens before an account is written or updated. Apply
the database migrations from the migration environment; migration
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
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` encrypted environment variables in
the Vercel runtime environment. Local and test profiles reject them. Never commit their real values.

Both GitHub variables must be set together. Until they are present, Google
authentication continues to work and GitHub attempts use the normal
provider-unavailable error flow.

Better Auth requests GitHub's user and email scopes and stores GitHub's stable
numeric user ID as the provider account ID. Account linking requires the same
verified email address; mutable GitHub usernames and email addresses are not
used as provider identity keys.

## Development authentication

- `DEV_AUTH_BYPASS` — runtime role only. Set to exactly `true` to enable
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

These are deployed runtime settings; local and test runtime files may set them
when needed.

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

## Database roles and row-level security

Migration `0024_least_privileged_runtime_role.sql` creates a non-owner,
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
vp run @repo/db#db:migrate
```

from the deployed migration environment described above.

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
