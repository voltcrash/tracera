# Cloudflare operations

Tracera runs one TanStack Start Worker with D1, private R2, Workflows, and five-minute Cron.
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
| `ANALYSIS_MAX_ELAPSED_MS`                   | Run duration from first attempt, at most 300000 |
| `ANALYSIS_MAX_CONCURRENT_EXTERNAL_CALLS`    | Concurrent external requests                    |
| `ANALYSIS_MAX_COST_USD`                     | Estimated per-run spend bound                   |
| `AI_DAILY_SPEND_LIMIT_USD`                  | Estimated daily platform-provider spend circuit |
| `AI_ESTIMATED_GENERATION_COST_USD`          | Conservative reservation per generation request |
| `AI_ESTIMATED_IMAGE_COST_USD`               | Conservative reservation per image request      |
| `AI_ESTIMATED_EMBEDDING_COST_USD`           | Conservative reservation per embedding request  |

All other count bounds must be positive integers; money values must be finite and positive.
The spend circuit uses configured estimates because adapters do not all return billable
usage. Platform calls settle with `estimated` basis, including failed calls and interrupted
reservations reconciled after one hour. A caller may supply `measuredUsd` only when a measured
charge is known; invalid measurements fail without settling. The first settlement wins.
Compare estimated charges with the provider dashboard; they are not a final invoice.

Reservation admission returns `reserved`, `existing` (pending or settled), or `rejected`.
Only a new `reserved` result authorizes provider work; reusing a retained reservation ID
never authorizes another execution. Reservation records are retained until their expiry
cleanup, so this is not an unlimited transport deduplication guarantee. A rejected estimate
that does not fit remaining capacity does not latch the circuit: smaller calls may still
fit, and a lower measured settlement can release reserved headroom. Settled charges reaching
the cap latch the circuit until UTC reset, even if the configured budget is then raised.
Existing circuit reset times are preserved during migration because their cause is unknown.
Estimates/charges round up to integer micro-dollars and budget caps round down.

The legacy SQL column `actual_micros` is the total settled charge, not necessarily measured
billing. `estimated_settled_micros` and `measured_settled_micros` attribute new charges by
basis; any remaining difference is historical unknown spend. Old settled reservation rows
receive `legacy_unknown` basis without changing balances or inventing an invoice source.

Live runs reserve each physical provider or public HTTP request against D1 before sending it.
Structured-output repairs and redirects consume requests too. Counts, conservative AI cost
estimates, and the first-attempt deadline survive Workflow retries, including calls made
before a checkpoint could be saved. A failed or interrupted request retains its reservation;
reusing a checkpoint does not charge its requests again. Each Workflow attempt also has its
own timeout, bounded by the remaining run duration.

The usage migration conservatively exhausts the allowance of already-started, unfinished
runs because their earlier uncheckpointed requests cannot be reconstructed. They cannot
receive a fresh budget after deployment; queued runs retain their full allowance.

Targeted retrieval has a separate run-wide D1 counter shared by assessment follow-ups and
all claims in adjudication. Each grant returns the next round number before retrieval starts;
failed or empty retrievals consume the grant too. Fencing, owner scope, cancellation, held
admission, and the first-attempt deadline gate grants. Retrying an attempt cannot reset this
counter. Migration `0010_targeted_round_budget.sql` exhausts the targeted allowance of
already-started, unfinished runs because their prior uncheckpointed rounds are unknown;
queued runs start at zero.

Adjudication follows these transitions:

| Current step     | Event                                                 | Next step                                                                                 |
| ---------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Validated draft  | A decisive verdict has admissible evidence            | Independent, label-blind challenge                                                        |
| Challenge        | Disagreement or applicable opposing evidence          | One targeted attempt, if the shared round and request allowances permit it                |
| Targeted attempt | Usable evidence changes                               | Fresh draft and independent challenge against the accumulated evidence                    |
| Targeted attempt | Retrieval fails, is empty, or adds no usable evidence | Retain the prior draft and challenge without rerolling model votes                        |
| Final gate       | Agreement with no applicable opposition               | Resolved challenge                                                                        |
| Final gate       | Disagreement or applicable opposition remains         | Unresolved challenge; independently sourced support and contradiction can produce `mixed` |

Targeted retrieval leaves room in the request cap for assessment, a fresh draft, and a new
challenge. Both adjudication and focused publication use the same opposing-evidence rule;
weak applicable opposition still prevents resolving the challenge. New assessments and
snapshots must be recorded before they can support a refreshed verdict.

D1 admission coordinates fixed-window rate limits, concurrency leases, daily quota,
idempotency, and forced-reanalysis cooldown across Worker instances. Defaults are 30 requests
per user and 60 per IP per hour, two concurrent runs per user and four per IP, 100 admissions
per user per UTC day, one-hour forced-reanalysis cooldown, and one-day idempotency retention.
Admission transitions from `in_progress` (an unbound claim) to `accepted` (a lease bound
to a persisted run), then to `completed` or `failed` with a settled response. The claim expires if persistence never happens. Run persistence and lease
binding are atomic; after binding, the lease holds both capacity and request identity until
terminal settlement, even if either TTL elapses. A running Workflow whose status cannot be
inspected retains capacity until reconciliation can confirm it stopped. Lease timer overrides
are extended to cover the bounded Workflow retry window.

Overrides: `ANALYSIS_USER_RATE_LIMIT`, `ANALYSIS_IP_RATE_LIMIT`,
`ANALYSIS_RATE_WINDOW_SECONDS`, `ANALYSIS_USER_CONCURRENCY_LIMIT`,
`ANALYSIS_IP_CONCURRENCY_LIMIT`, `ANALYSIS_DAILY_QUOTA`,
`ANALYSIS_FORCE_REANALYSIS_COOLDOWN_SECONDS`, `ANALYSIS_LEASE_SECONDS`, and
`ANALYSIS_IDEMPOTENCY_TTL_SECONDS`. Reusing an idempotency key for a different request fails;
reusing an accepted request replays its original 202 response with the same run ID, while
settled requests replay their stored terminal response. Replays precede runtime/provider
availability checks and do not charge admission counters. Before persistence, an active claim
still returns `idempotency_in_progress`. Expired claims cannot persist a run, and released
ownership cannot start attempts or reserve external requests. Settlement cannot release a
bound run before it is terminal.

Checkpoint envelopes retain v2 compatibility but are validated against the requested stage’s
result and retry metadata before reuse. Invalid JSON, wrong stage data, or malformed extras
are cache misses: recomputation still uses the existing run budget and deadline. Newly written
checkpoints use the same stage schemas. A partial or unavailable stage is a recorded outcome,
not a claim that the stage succeeded.

Engine boundaries return an explicit `continue` or `stop` transition. `complete` and `partial`
results carry data; `failed` and `unavailable` results carry none. Dynamically selected
statuses use a checked constructor, and every non-complete result requires a typed issue.
Each boundary retains its produced artifacts and metrics before applying its stop decision.
Owner cancellation takes precedence over simultaneous request, cost, or elapsed limits.
A failed mandatory provenance reassessment retains the acquired graph and snapshots, but
stops before adjudication can use unassessed evidence.

Provenance traversal retains each attempted claim/document assessment outcome. Repeated
citation paths reuse the same outcome, including empty or rejected evidence, rather than
requesting another assessment. The orchestrator loads the new immutable snapshots, merges
the retained assessments into the full evidence set, recomputes source dependence, and
assesses only the remaining selected-claim/document pairs. Traversal metrics already include
its assessments; reuse does not add those charges again. Successful trace checkpoints retain
these outcomes and any additional assessments. Historical v2 checkpoints remain readable;
checkpoints containing a failed traversal or follow-up assessment are cache misses, so a
fresh fenced attempt can retry instead of replaying the failure indefinitely.

Decision state distinguishes diagnostics from evaluated publication. If the run stops before
publication, its diagnostic decisions remain in the report with an explicit `not_evaluated`
publication status and gate, an unverified released label, and no statistical calibration.
This cannot authorize a decisive released label. A completed scorecard survives a subsequent
budget/deadline stop; owner cancellation always suppresses it. Valid historical reports and
v2 checkpoints remain readable.

Report publication moves from analysis to a durable prepared report, then to a terminal
published run. After storing the report in R2, the Workflow records its URI, canonical
report hash, status, and original fencing token in `core_runs.prepared_report` before
returning the analysis step result. Preparation is immutable and idempotent; it blocks
new attempts and failure settlement while publication is pending. Finalization checks
the report and its snapshots, then atomically writes the report projections and terminal
run status against the observed preparation and fence. Owner cancellation still wins
if it commits before publication.

Workflow retries and exhausted-analysis settlement reuse prepared metadata before doing
provider work or failing the run. Maintenance publishes prepared reports even when the
Workflow status service is unavailable, and releases their admission through normal
terminal settlement. Missing, unreadable, or corrupt report blobs remain pending for a
later recovery attempt, with `reportRecoveryErrors` counted instead of a failed run;
successful recovery increments `reportsRecovered`. Report content stays out of Workflow
step results. Existing runs default to no prepared report, and historical successful
step outcomes remain publishable through the original pointer path. A blob write without
a committed preparation cannot be inferred as ready from historical R2 objects.

Acquisition completion derives from the retained snapshot and typed limitations. Both byte
and character truncation produce a partial result, including a fully downloaded HTTP text
response that exceeds the character cap. Empty or whitespace-only HTTP text is explicitly
unavailable content. New snapshot identities include extraction status so complete and
bounded captures of identical retained bytes remain distinct; stored historical IDs stay intact.

OCR distinguishes unavailable, failed, empty, and recognized outcomes. A caption remains
user-supplied context when OCR fails or returns no readable regions, and cannot make image
extraction complete. Reader fallback records its limitations and truncation, and retains its
attempt usage even when it returns no text. Missing reverse-image or content-credentials
capabilities remain explicit limitations, rather than evidence of fabrication.

Claim inventory completeness is independent of the analysis allowance. An accepted claim
outside that allowance remains explicitly deferred, while its inventoried segment has factual
coverage; unread or unsupported segments still make extraction partial. A claim deferred
before focused selection carries that reason without assuming extraction failed.

New focused selection metadata uses `selected` entries and `inventory.selectedClaims`.
Historical `analyzed` entries and `inventory.analyzedClaims` remain readable as selection
aliases, and contradictory counters are rejected. Scoring keeps selected claim IDs as its
denominator. Report views show selection count separately from `decisionsAvailable`, derived
from actual diagnostic decision records; the view's legacy `analyzedClaims` alias follows that
availability count. A selected claim without a decision is shown as `No decision`, rather
than being described as already checked. Reports without focused-selection metadata use a
generic claim inventory heading, including stops before selection and historical reports.
Decision availability does not bypass publication.

Progress exposes `recordedStages`, `lastCheckpointedStage`, and `nextStage` (the first stage
without a checkpoint). The legacy `completedStages` alias and persisted `stage` hint remain
for existing clients; the UI and Workflow resume hint use the explicit projection. An entry in
`core_stage_attempts` tracks a fenced run attempt, not a separate attempt for every checkpoint.
Lifecycle triggers in migration `0008_run_state_guards.sql` require terminal timestamps,
paired attempt outcomes/timestamps, and valid run attempt/fence states. Terminal lifecycle state
and settled attempt outcome/timestamps cannot be reopened or rewritten. The migration fills
missing terminal timestamps from their last recorded update and leaves active runs active.
Preserve these custom triggers if a future migration rebuilds either table.

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

Cron runs every five minutes. It purges expired unheld idempotency records and released or
expired unbound leases,
old rate windows, expired sessions and verifications, and stale spend reservations. It also
marks runs failed when their Workflow instance errored. Owner/operator cancellation follows
`requested → canceled`: the first request fixes its timestamp and reason, and retries return
acceptance without changing the run version or extending the five-second grace period.
Queued runs cancel immediately; active runs acknowledge at the next checkpoint or are
terminated after that original grace period. A failure write atomically settles as canceled
if cancellation committed first. A failure or publication that already committed stays terminal.
Deadline and budget stops have separate engine issue codes and do not imply owner cancellation.
An untyped abort signal retains ordinary cancellation semantics; `TimeoutError` signals denote
a deadline. Cancellation cleanup retains admission until the Workflow is confirmed stopped. Retries resume from a checkpoint with a new
fencing token; stale attempts cannot persist or finalize. Diagnose an error before considering
an approved instance operation; preserve run ownership, fencing, and idempotency identities.

Run creation persists a pending launch intent and admission IDs in D1 before sending the
Workflow create request; recovery does not need to load the raw submission from R2.
A failed create response is treated as uncertain: an existing instance confirms launch;
otherwise the accepted run remains queued for reconciliation. After a 30-second grace
period, Cron retries with the original Workflow/run ID while its admission remains held.
Recovery is bounded to ten minutes from submission and never restarts canceled or released
admissions. A bound launch retains admission across its initial lease timer. An unrecoverable launch becomes a replayable failure and releases admission.
An instance that remains queued past that window also fails its run instead of waiting forever.
Completed Workflows with unfinished database runs are reconciled to failure as well.

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
