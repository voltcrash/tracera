# Cloudflare operations

Tracera runs one TanStack Start Worker with D1, private R2, Workflows, and hourly Cron.
Node.js 24 LTS is used for tooling; local requests execute in workerd. The default Wrangler
config targets staging, and production has its own config and resources.

## Local fixture development

From the repository root:

```sh
vp install
cp -n apps/web/.dev.vars.example apps/web/.dev.vars
chmod 600 apps/web/.dev.vars
vp run db:migrate
vp run dev
```

Open `http://localhost:3000`. The ignored private file is
`apps/web/.dev.vars`; keep an existing file when repeating setup. Its local settings are
`MODE=dev`, `ANALYSIS_MODE=fixture`, and `DEV_AUTH_BYPASS=true`, with the local-only auth
secret from the example. Fixture analysis and synthetic Ada/Grace sign-in need no hosted
credentials. OAuth providers appear only when their complete credential pairs are configured.
The bypass is restricted to development on a loopback origin and creates real D1 sessions.

Local D1, R2, and Workflow state live under `apps/web/.wrangler/state`, separately in each
worktree. No Cloudflare login is needed for local development. Stop the development server
before deleting local D1 with `vp run db:reset`; that command remigrates only local D1 and
leaves local R2 state in place.

For a fixed port, use `vp run dev --host 127.0.0.1 --port 3000 --strictPort`. Use another port
when running a second worktree. Browser tests require port 3000 to be available.

## Validation

```sh
vp check
vp test --run
vp run check-types
vp run build
vp exec --filter web --fail-if-no-match -- playwright install chromium
vp run test:browser
vp run evaluate:analysis-release:fixture
vp run evaluate:analysis-retrieval:replay
```

The unit suites use real Miniflare D1/R2 and native Workflow tests. Playwright starts a local
Worker on a fixed port, uses real sessions and fixture analysis, and cleans its reserved
synthetic rows. It preserves an existing `.dev.vars` and rejects a file that does not enable
the expected local fixture/bypass modes. Fixture success verifies code paths; hosted OAuth,
provider access, and live analysis quality require validation on the hosted environment.

## Configurations and bindings

| Item                           | Staging                                         | Production                          |
| ------------------------------ | ----------------------------------------------- | ----------------------------------- |
| Config                         | `apps/web/wrangler.jsonc`                       | `apps/web/wrangler.production.json` |
| Worker                         | `tracera-staging`                               | `tracera`                           |
| Origin                         | `https://tracera-staging.voltcrash.workers.dev` | `https://tracera.voltcrash.com`     |
| D1 / `DB`                      | `tracera-staging`                               | `tracera-production`                |
| R2 / `BLOBS`                   | `tracera-staging-blobs`                         | `tracera-production-blobs`          |
| Workflow / `ANALYSIS_WORKFLOW` | `tracera-staging-analysis`                      | `tracera-production-analysis`       |

Both use account `eb2679ce4f23ae7db4e6c4e3fcf8c3c1`. Production disables workers.dev and
preview URLs. The actual resource UUIDs live in the configs.
Local development emulates the bindings and does not query those hosted databases.

Private files are `.dev.vars` for local development, `.dev.vars.staging` for hosted staging
preparation, and `.dev.vars.production` for production. All live under `apps/web`, are ignored,
and should have mode `0600`. Keep secret values out of public vars, screenshots, logs, and Git.
Runtime code reads `cloudflare:workers` bindings through the validated server environment;
build scripts and evaluator CLIs use their own explicit inputs.

Hosted credentials use distinct auth secrets and OAuth apps. Preserve existing auth secrets
when preparing the hosted files.
A partial GitHub or Google pair is rejected. Production requires both pairs; staging and local
development offer whichever complete pairs are configured.

## AI provider overrides

Hosted Workers may run with no AI provider at all. Analysis then answers
`analysis_unavailable` with a plain message, and sign-in, history, and settings keep working.
Enabling analysis later needs the settings below plus every run and spend bound, uploaded as
secrets or reviewed vars, followed by a deploy.

`vp run dev:live` selects live analysis while retaining local D1/R2 and development auth.
It reads the provider settings in `apps/web/.dev.vars`. The focused runtime requires all of
`AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`, and `AI_EMBEDDING_MODEL` explicitly. Configure model
identifiers supported by the selected provider and account; adapter defaults do not satisfy
the focused runtime's reproducibility checks.

| Setting                 | Purpose                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `AI_PROVIDER`           | `gemini`, `openai`, `anthropic`, `openrouter`, or `openai-compatible`   |
| `AI_MODEL`              | Generation model recorded in the run version                            |
| `AI_API_KEY`            | Private generation provider credential                                  |
| `AI_BASE_URL`           | Optional override; required for `openai-compatible`                     |
| `AI_EMBEDDING_MODEL`    | Embedding model recorded in the run version                             |
| `AI_EMBEDDING_PROVIDER` | Separate embedding provider; required with Anthropic generation         |
| `AI_EMBEDDING_API_KEY`  | Required with a separate embedding provider                             |
| `AI_EMBEDDING_BASE_URL` | Optional override; required for separate `openai-compatible` embeddings |

Anthropic cannot be the embedding provider. Without a separate embedding provider, its key
and base URL overrides must be absent. The embedding adapter contract remains 1024 dimensions;
the runtime does not store claim vectors or use a persisted embedding corpus.
`GOOGLE_FACT_CHECK_API_KEY` and `NEWS_API_KEY` are optional evidence-source credentials.
The resolver prefers the user's active encrypted key and uses platform credentials when none
is active. See [bring your own key](bring-your-own-key.md) for setup, supported providers,
verification, rotation, and the BYOK-only deployment controls.

Fixture evaluators require no settings and never fall back to a provider. The separate
`vp run @repo/ai#test:live` adapter diagnostic reads provider settings from the invoking shell,
not from Wrangler's private file, and makes a paid-capable provider request. Do not run it
until the owner has chosen credentials and authorized the test. Evaluation scripts reject
unsupported live/replay modes explicitly; the full release evaluator still requires its
human-gold and authorization prerequisites before live evaluation.

## Run and spend bounds

Choose every live bound explicitly before enabling a provider. Non-secret hosted bounds can
be reviewed in Wrangler vars; the private-file examples also support them.

| Setting                                     | Meaning                                         |
| ------------------------------------------- | ----------------------------------------------- |
| `ANALYSIS_MAX_EXTERNAL_REQUESTS`            | External requests per run                       |
| `ANALYSIS_MAX_DISCOVERY_QUERIES_PER_CLAIM`  | Discovery queries per selected claim            |
| `ANALYSIS_MAX_FETCHED_CANDIDATES_PER_CLAIM` | Fetched candidates per selected claim           |
| `ANALYSIS_MAX_PROVENANCE_HOPS`              | Provenance traversal depth                      |
| `ANALYSIS_MAX_TARGETED_RETRIEVAL_ROUNDS`    | Targeted retrieval rounds; zero is allowed      |
| `ANALYSIS_MAX_ELAPSED_MS`                   | Attempt duration, positive and at most 300000   |
| `ANALYSIS_MAX_CONCURRENT_EXTERNAL_CALLS`    | Concurrent external requests                    |
| `ANALYSIS_MAX_COST_USD`                     | Estimated per-run spend bound                   |
| `AI_DAILY_SPEND_LIMIT_USD`                  | Estimated daily platform-provider spend circuit |
| `AI_ESTIMATED_GENERATION_COST_USD`          | Conservative reservation per generation request |
| `AI_ESTIMATED_IMAGE_COST_USD`               | Conservative reservation per image request      |
| `AI_ESTIMATED_EMBEDDING_COST_USD`           | Conservative reservation per embedding request  |

All other count bounds must be positive integers; money values must be finite and positive.
The spend circuit uses configured estimates because adapters do not all return billable
usage. Failed calls are settled too. Compare the estimates with the provider usage dashboard;
they are not a guarantee of the provider's final invoice.

D1 admission coordinates fixed-window rate limits, concurrency leases, daily quota,
idempotency, and forced-reanalysis cooldown across Worker instances. Defaults are 30 requests
per user and 60 per IP per hour, two concurrent runs per user and four per IP, 100 admissions
per user per UTC day, one-hour forced-reanalysis cooldown, and one-day idempotency retention.
Leases are extended to cover the bounded Workflow retry window when an override is too short.

Overrides: `ANALYSIS_USER_RATE_LIMIT`, `ANALYSIS_IP_RATE_LIMIT`,
`ANALYSIS_RATE_WINDOW_SECONDS`, `ANALYSIS_USER_CONCURRENCY_LIMIT`,
`ANALYSIS_IP_CONCURRENCY_LIMIT`, `ANALYSIS_DAILY_QUOTA`,
`ANALYSIS_FORCE_REANALYSIS_COOLDOWN_SECONDS`, `ANALYSIS_LEASE_SECONDS`, and
`ANALYSIS_IDEMPOTENCY_TTL_SECONDS`. Reusing an idempotency key for a different request fails;
reusing the same completed request replays the stored response.

## Migrations and deployment preparation

`packages/db/src/schema.ts` and its auth schema describe D1. Drizzle generates SQL and
metadata in `packages/db/migrations`; Wrangler applies migrations. Review generated SQL
and commit it with its metadata. Do not rewrite applied migrations.

```sh
vp run db:generate
vp run @repo/db#db:generate:auth
vp run db:migrate
vp run web#deploy:staging-dry-run
```

The auth generator writes `tmp/auth-schema.sqlite.ts` for comparison with the reviewed auth
schema. It does not overwrite it. The D1 suite applies the real migration files to fresh
SQLite, tests batch rollback, and covers ownership and fencing.

Hosted migrations and deploys are separate from local commands. The default staging deploy
script migrates staging, builds, and uploads the Worker; production commands explicitly select
its config and private file.
Production checks validate isolated bindings, the built config, auth/provider credentials,
live mode, and explicit budgets. Use the staging and production setup guides before them.

## Workflow and Cron recovery

Workflow instance IDs equal run IDs. Parameters carry IDs and input references, while keys
are resolved inside execution steps. Inspect reviewed run IDs with:

```sh
vp exec --filter web -- wrangler workflows instances describe tracera-staging-analysis RUN_ID
vp exec --filter web -- wrangler tail --config wrangler.jsonc
```

Cron runs hourly at minute 17. It purges expired idempotency records, released/expired leases,
old rate windows, expired sessions and verifications, and stale spend reservations. It also
marks runs failed when their Workflow instance errored. Cancellation sets the D1 flag and
terminates the instance after its grace period. Retries resume from a checkpoint with a new
fencing token; stale attempts cannot persist or finalize. Diagnose an error before considering
an approved instance operation; preserve run ownership, fencing, and idempotency identities.

## D1 capacity and Time Travel

Monitor D1 database size, query duration/rows, Worker errors, and R2 payload growth. Payloads
larger than 1.5 MB are offloaded to R2 with a content hash and pointer. D1 statements chunk
large reads and use JSON arrays to respect binding limits.

[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) retains recovery
history for 30 days on Workers Paid and 7 days on Workers Free. Restores overwrite the database
in place and cancel in-flight queries. Record a current bookmark before migrations or a
restore, and preserve the previous bookmark returned by a restore so it can be undone.

```sh
vp exec --filter web -- wrangler d1 time-travel info tracera-production --config wrangler.production.json --json
vp exec --filter web -- wrangler d1 export tracera-production --remote --config wrangler.production.json --output /PRIVATE_PATH/tracera-d1.sql
```

Exports contain private data; use a private directory and restrict the resulting file.
For an approved restore to a reviewed bookmark:

```sh
vp exec --filter web -- wrangler d1 time-travel restore tracera-production --config wrangler.production.json --bookmark BOOKMARK
```

Stop writes and Workflow execution through an approved maintenance procedure before restoring.
Use a code version compatible with the restored schema, and verify R2 objects referenced by
restored rows; D1 Time Travel does not restore R2. Recheck auth, run history, ownership,
controls, and a bounded analysis before reopening writes. Record the bookmarks, timings,
and recovery results for each restore.

## CI and deployment validation

[CI](../.github/workflows/ci.yml) installs dependencies and Chromium, checks formatting/types,
runs unit tests with external networking denied, builds the Worker, dry-runs both configs,
and runs Playwright with external networking denied. Only loopback is allowed during those
suites, and no Docker or hosted credentials are needed. The production dry run uses temporary
synthetic settings, mode `0600`, and always removes them.

The [deployment helpers](../packages/release/README.md) test exact-commit CI gating, retry behavior,
unchanged deployments, read-only GitHub permissions and actual workflow scripts using command
stubs. Artifact tests cover tampering, mixed build identities and private-file exclusion.
Both real Worker dry-runs validate packaging separately. Hosted staging remains manual;
production follows successful main-push CI. See [production setup](production-setup.md) for the
single-build pipeline, D1 optimization/replication, and manual retries.
