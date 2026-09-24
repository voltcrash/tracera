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
vp run local:setup
vp run env:diagnose:local
```

Setup derives stable database and web ports from the current worktree path, creates strong random local passwords and a Better Auth secret, and writes mode-0600 files under ignored `.tracera/environment/local` and `.tracera/environment/test` directories. Existing generated files are retained, so rerunning setup does not rotate database credentials unexpectedly. Setup safely adds missing local-auth and offline-analysis settings to an existing generated profile without reading or replacing its secrets.

The committed shape is documented in `config/environment/local.generated.env.example`; never copy its placeholders. The local and test profiles use separate database ports, and the web app uses a third generated port (see [Local PostgreSQL](#local-postgresql)). Local sign-in and deterministic offline analysis are available through the synthetic identities and fixtures described below.

The concise daily workflow, integration command, reset behavior, and CI boundary are in
[`docs/local-development.md`](local-development.md). `vp run local:up`
starts and health-checks an already configured database, `vp run local:reset` resets only
this worktree's development data, and `vp run local:down` stops it without deleting data.

## Loading and precedence

The launcher reads exactly two files, in order:

1. `.tracera/environment/<profile>/shared.env`
2. `.tracera/environment/<profile>/<role>.env`

Keys cannot appear in both files; duplicates are errors rather than overrides. Profile and role markers are launcher-owned and cannot appear in either file. Unknown managed keys are rejected.

Before loading local/test files, the launcher rejects:

- inherited Tracera database, auth, provider, or profile variables;
- `.env` or `.env.*` files (other than `.env.example`) in the repository root, `apps/web`, or the `ai`, `auth`, and `db` packages, because Next.js loads them implicitly;
- missing generated files.

After loading, it seals the selected values. Import-time and connection-entry validation detects role changes, injected managed values, or modifications to the selected target before a database connection opens. Diagnostics report only the profile, role, database username, loopback host, port, and database name; passwords, secrets, tokens, and query parameters are never displayed.

This fail-closed policy means exported production variables do not override local values. Unset them before launching a local/test command; do not paste them into generated files.

## Local target validation

Local/test database URLs must:

- use `postgresql:` or `postgres:`;
- use `localhost`, `127.0.0.1`, or `::1`;
- match the generated worktree host, port, and database name;
- use `tracera_runtime`, `tracera_migrator`, or `tracera_test_provisioner` according to the selected role.

`ANALYSIS_STORAGE_TEST_DATABASE_URL` is accepted only by the `test` profile's runtime role. It must satisfy the same rules as the runtime URL, except that its database name must be a disposable database prefixed with the generated test database name (`<name>_<run>`). The Analysis storage integration test validates it before opening a pool; setting it without the test profile fails instead of connecting.

The test profile's runtime and migration URLs may also target a run database `<name>_<run>`, where `<run>` is 1–16 lowercase letters or digits. Tooling derives these URLs only through `withTestRunDatabase`, which rewrites the database name of the sealed generated URL and reseals it; local profiles never accept a suffix.

Local/test runtime configuration also requires `TRACERA_APP_ORIGIN` and `TRACERA_APP_PORT`. The origin must be an HTTP loopback URL whose port matches the generated value. The development server binds that worktree-specific port; a copied, remote, or mismatched origin fails validation before auth or database access.

Local/test runtime and analysis roles require `TRACERA_ANALYSIS_MODE=fixture`. They reject OAuth client secrets, AI credentials and custom endpoints, and optional paid retrieval credentials. Deployed profiles reject fixture mode and `AI_PROVIDER=fixture`. Local auth never configures a social provider.

## Local PostgreSQL

Each worktree runs two PostgreSQL 18 clusters with pgvector 0.8.6 from the digest-pinned `pgvector/pgvector:0.8.6-pg18-trixie` image. A Docker-compatible engine is required: the tooling uses `docker` on `PATH` and falls back to OrbStack's bundled CLI and context. Redis, hosted databases, and cloud storage are not used.

| Profile | Container                     | Storage                                         | Port                     |
| ------- | ----------------------------- | ----------------------------------------------- | ------------------------ |
| `local` | `tracera-<worktree-id>-local` | named volume `tracera-<worktree-id>-local-data` | generated local port     |
| `test`  | `tracera-<worktree-id>-test`  | tmpfs; discarded when stopped                   | generated local port + 1 |

Ports are published only on `127.0.0.1`. Containers and volumes carry `dev.tracera.*` labels with the profile, worktree ID, and a SHA-256 of the worktree's real path. Every command verifies those labels and the port binding before it uses, stops, or deletes a resource. It refuses a same-named resource owned by another worktree, a port held by another process, or generated configuration copied from another worktree.

Commands (they accept no URLs or database names):

```sh
vp run db:local:start    # create or start, health-check, bootstrap roles and database
vp run db:local:migrate  # apply migrations as tracera_migrator, then set the runtime password
vp run db:local:status   # container state and health; exits 1 when not running
vp run db:local:stop     # stop without deleting the development volume
vp run db:local:reset    # delete this worktree's local container and volume, recreate, migrate
vp run db:test:start     # start the disposable test cluster
vp run db:test:stop      # stop and discard the test cluster
vp run db:rehearse       # full migration and runtime-privilege rehearsal (see below)
vp run test:analysis-storage # fresh database, real Analysis storage integration suite, cleanup
```

`vp run dev` and `vp run db:local:migrate` fail with a start instruction unless this worktree's container is running and healthy.

`vp run dev` prints the generated local web origin. Open that exact `http://localhost:<port>` URL rather than assuming port 3000.

`vp run test:analysis-storage` exclusively locks this worktree's disposable test cluster,
recreates it, applies the full migration history to a fresh run database, runs the
Analysis storage suite as `tracera_runtime`, and removes the run database and cluster even
after failure. It accepts no URLs or database names, fails when any test is skipped or
when zero tests execute, and never uses runtime `DELETE` privileges for cleanup.

### Roles and privileges

- **Bootstrap:** the container superuser `postgres`. Bootstrap clears its password, so it is reachable only through `docker exec` on the container-local socket. It creates the login roles from the generated passwords and installs `vector` into `template1`, because pgvector is not a trusted extension. Failed bootstrap statements are kept out of server logs and redacted from command output.
- **Migrator** (`tracera_migrator`): owns the Tracera database and every migrated object. It has `CREATEROLE` (required by migration 0024) but not superuser, `CREATEDB`, replication, or `BYPASSRLS`.
- **Runtime** (`tracera_runtime`): created by migration 0024 as the migrator, with no inherited roles. Bootstrap sets its password after migrations. Table privileges come only from migrations 0024 and 0029. It has `CONNECT` on its database and `USAGE` on `public`. It has no `CREATE`, `TEMP`, DDL, `TRUNCATE`, or maintenance-database access.
- **Test provisioner** (`tracera_test_provisioner`, test cluster only): `CREATEDB`, with `SET` (not inherited) on the migrator so it can create and drop migrator-owned run databases, and `pg_signal_backend` to end a run database's sessions before dropping it.

`PUBLIC` has no privileges on any database. `scripts/database/runtime-grants.mjs` lists the expected runtime privileges for every public table; a new table must be added there and granted through a reviewed migration.

Migration 0024's existing-role branch runs `ALTER ROLE tracera_runtime ... NOSUPERUSER`, which vanilla PostgreSQL allows only for superusers. Neon's owner role permits it. To stay compatible without rewriting 0024 or migrating as a superuser, each local or test cluster hosts exactly one migrated Tracera database lifecycle: local reset recreates the cluster, and each rehearsal starts a fresh test cluster.

### Connection transports

`@repo/db/connection` selects the driver from the validated profile. `local` and `test` use node-postgres (`pg`) over TCP; `deployed` keeps Neon's serverless pool with HTTP queries and WebSocket transactions. Before configuration, the database module uses a pool that rejects every query instead of falling back to default `PG*` settings. `drizzle-kit` prefers `pg` when installed, so migrations in every profile now use the standard PostgreSQL wire protocol.

### Migration rehearsal

`vp run db:rehearse` recreates the test cluster, bootstraps it, and creates run database `<test-name>_<run>` as the test provisioner. It then:

1. applies the full migration history as the migrator and verifies that every journal entry has a file, and each applied SHA-256 hash and timestamp matches;
2. migrates again and requires identical migration rows and schema/ACL fingerprint;
3. audits runtime table, column, schema, database, and role privileges against the reviewed map;
4. runs `packages/db/test/postgres.integration.test.ts` with only the sealed runtime environment. The command fails if any test fails or is skipped, or if none run;
5. drops the run database as the provisioner and confirms it is gone, including after failures.

## Deployed configuration

Deployment examples are split by role:

- `config/environment/deployed.runtime.env.example`
- `config/environment/deployed.migration.env.example`
- `config/environment/deployed.analysis.env.example`

**Deployment requirement.** `next.config.js`, the request proxy, and database configuration fail closed when Tracera settings are present without a profile. The hosted web environment (build and runtime) must set `TRACERA_PROFILE=deployed` and `TRACERA_CONFIG_ROLE=runtime`, and must not contain `DATABASE_MIGRATOR_URL`, `TEST_DATABASE_PROVISIONER_URL`, or `ANALYSIS_STORAGE_TEST_DATABASE_URL`.

Do not combine them. The web deployment should receive the runtime example's settings only. The operator migration environment should receive the migration example's settings only. AI validation scripts are live-capable only under an explicitly selected and valid environment; local/test profiles reject their credentials before the script runs.

Analysis deployment values include:

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

## OAuth token storage

Tracera uses provider tokens only while completing an OAuth callback. Better
Auth encryption remains enabled as defense in depth, while account hooks drop
access, refresh, and ID tokens before an account is written or updated.

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

## Local development authentication

`vp run env:setup` adds `DEV_AUTH_BYPASS=true`, `TRACERA_APP_ORIGIN`, and
`TRACERA_APP_PORT` only to the generated local runtime profile. Start and migrate the
local database, then run `vp run dev` and open the exact reported origin. The landing
page replaces unavailable OAuth buttons with two fixed synthetic identities:
`ada@tracera.local` and `grace@tracera.local`.

Each action uses `GET /api/auth/dev-login?identity=<fixed-id>` to create or load the
synthetic user, create a real Better Auth session in local PostgreSQL, set the normal
HTTP localhost session cookie, and redirect to `/home`. Page reload, session lookup,
and logout use Better Auth's regular endpoints and database adapter. Local cookies are
deliberately non-secure because the validated origin is loopback HTTP; deployed cookies
remain forced secure.

The login plugin requires all of the following simultaneously: profile `local`, role
`runtime`, generated and sealed worktree configuration, `NODE_ENV=development`, exact
`DEV_AUTH_BYPASS=true`, a validated local runtime database URL, and a request matching
the configured loopback origin. Unknown identities and mismatched origins return 404.
The plugin and identity listing are unavailable in test and deployed profiles, and
local auth has no OAuth providers configured. Deployed Google/GitHub behavior and OAuth
token discarding are unchanged.

Run `vp run test:auth-browser` after the local database is running and migrated. The
command starts the app on the generated port and runs one Chromium test covering both
identities, database-backed session persistence across reload, logout, and private trace
isolation. The web process receives only the runtime profile. The wrapper loads the
generated migrator profile separately to remove only the users with the two synthetic
email addresses; it never accepts a URL or database name.

## Deterministic analysis evaluation

Local and test profiles run the registered analysis evaluators with scripted ports. These
fixtures use no hosted AI credentials, external retrieval services, or arbitrary document URLs.
They exercise contract and orchestration behavior only and are not accuracy evidence.

The browser acceptance suite mocks the analysis API response. Local interactive
submissions remain unavailable unless the live runtime is configured in a deployed
profile.

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

`/api/tracera/analyze` requires an
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

Analysis thresholds, embedding dimensions, site origins,
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
