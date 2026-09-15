# Core v2 production configuration proposal

> **Historical context — superseded full-release proposal.** This is the unapproved, undeployed
> production-cutover proposal produced for the original full Core v2 release program. It is not
> required or activated by Core v2 Focused, and it must not be treated as deployment evidence. Use
> [`FOCUSED-PLAN.md`](FOCUSED-PLAN.md) for the active product path.

Status: **proposal only; not approved or deployed**.

This proposal keeps the existing Vercel web deployment as the HTTP/UI plane and runs the durable
Core v2 worker as a separate long-lived process on Fly Machines. The worker must not be a detached
promise in a browser request, and it must not run the fixture provider. Task 13 may activate this
proposal only after the release decision is PASS and deployment authorization is recorded.

## Hosting and scheduling

Vercel documents finite function duration, request/response limits, no WebSocket server support,
and duplicate/overlapping cron delivery. Those constraints make a continuously polling durable
worker a poor fit for the web function or a cron-only schedule. See the current
[Vercel function limits](https://vercel.com/docs/functions/limitations),
[Vercel platform limits](https://vercel.com/docs/limits), and
[Vercel Cron delivery guidance](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

The proposed worker host is a Fly Machines process group. Fly documents separate process groups
that can be scaled independently and a long-running-task pattern with a worker group that has no
HTTP service and does not autostop. See
[Fly process groups](https://fly.io/docs/launch/processes/) and the
[Fly long-running task blueprint](https://fly.io/docs/blueprints/long-running-tasks/).

Proposed topology:

| Process     | Host                                | Command                                         | Initial scale | HTTP service |
| ----------- | ----------------------------------- | ----------------------------------------------- | ------------: | ------------ |
| Web         | Existing Vercel project             | Existing `vp run --filter web build` deployment |      Existing | Yes          |
| Core worker | Fly Machines `worker` process group | `vp run @repo/ai#worker:core`                   |             1 | No           |

The worker polls the durable queue, renews its lease, observes cancellation, retries fenced
failures, and settles reservations. Its current code defaults are a 60-second worker lease, a
250 ms idle poll, a 1-second retry backoff, and a 1-second cancellation poll. A second worker is
not recommended until the staging backpressure and spend rehearsals prove that the shared limits
remain effective.

## Role-separated configuration

The web and worker processes use the deployed **runtime** role. The migration command uses the
deployed **migration** role and its owner URL in a separate operator environment. Never combine
`DATABASE_MIGRATOR_URL` with the web or worker runtime environment. Never copy local/test generated
configuration or credentials into deployment.

The approved runtime shape is:

```dotenv
TRACERA_PROFILE=deployed
TRACERA_CONFIG_ROLE=runtime
DATABASE_URL=postgresql://tracera_runtime:REDACTED@HOST/DATABASE?sslmode=require
BETTER_AUTH_SECRET=<secret-manager-value>
GOOGLE_CLIENT_ID=<secret-manager-value>
GOOGLE_CLIENT_SECRET=<secret-manager-value>
AI_PROVIDER=gemini
AI_API_KEY=<secret-manager-value>
AI_MODEL=<exact-stable-model-id-approved-after-development-comparison>
AI_EMBEDDING_MODEL=<exact-stable-embedding-model-id-or-provider-default>
ANALYSIS_USER_RATE_LIMIT=30
ANALYSIS_IP_RATE_LIMIT=60
ANALYSIS_RATE_WINDOW_SECONDS=3600
ANALYSIS_USER_CONCURRENCY_LIMIT=2
ANALYSIS_IP_CONCURRENCY_LIMIT=4
ANALYSIS_DAILY_QUOTA=100
ANALYSIS_FORCE_REANALYSIS_COOLDOWN_SECONDS=3600
ANALYSIS_LEASE_SECONDS=600
ANALYSIS_IDEMPOTENCY_TTL_SECONDS=86400
AI_DAILY_SPEND_LIMIT_USD=25
AI_ESTIMATED_GENERATION_COST_USD=<measured-conservative-estimate>
AI_ESTIMATED_IMAGE_COST_USD=<measured-conservative-estimate>
AI_ESTIMATED_EMBEDDING_COST_USD=<measured-conservative-estimate>
```

`AI_MODEL` is intentionally not filled with a guessed model name. Google's
[model documentation](https://ai.google.dev/gemini-api/docs/models) distinguishes stable,
preview, latest, and experimental IDs; the exact selected ID and capabilities must be captured
from the provider's [Models API](https://ai.google.dev/api/models) during the authorized
development comparison. A deployed profile must never set `TRACERA_ANALYSIS_MODE=fixture` or
`AI_PROVIDER=fixture`.

The values above are the exact proposed starting controls, not measured capacity or accuracy
claims. They preserve the current admission and spend-control behavior. The three estimated cost
values must be replaced with conservative provider-specific estimates before activation; actual
provider billing must be observed and recorded separately.

## Frozen run limits

The first approved production profile should use the existing Core v2 evaluation caps until a
measured frontier supports a narrower or larger profile:

| Limit                        |                                                                                                                Proposed value |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------: |
| External requests per run    |                                                                                                                           120 |
| Discovery queries per claim  |                                                                                                                            12 |
| Fetched candidates per claim |                                                                                                                            20 |
| Provenance hops              |                                                                                                                             3 |
| Targeted retrieval rounds    |                                                                                                                             2 |
| Elapsed run cap              |                                                                                                       600,000 ms (10 minutes) |
| Concurrent external calls    |                                                                                                                             3 |
| Per-run hard cost ceiling    | Keep `null` only while reservations enforce the approved daily circuit; add a measured per-run ceiling before paid activation |

Any future limit change must be a versioned configuration change, replayed against fixed evidence,
and followed by a fresh calibration/holdout decision when it can affect model output or coverage.

## Migration and deployment commands for approval

These commands are approval-gated runbook commands. They were not run for Task 12.

1. Verify the target commit and role-separated secrets without printing values:

   ```sh
   git rev-parse HEAD
   test "$TRACERA_PROFILE" = deployed
   test "$TRACERA_CONFIG_ROLE" = migration
   test -n "$DATABASE_MIGRATOR_URL"
   test -z "${DATABASE_URL:-}"
   ```

2. Apply the reviewed additive migration history as the migrator. This command must point at the
   approved production database and must not be run with a reset or destructive database command:

   ```sh
   TRACERA_PROFILE=deployed \
   TRACERA_CONFIG_ROLE=migration \
   vp run @repo/db#db:migrate
   ```

3. Build and deploy the web process using only the runtime environment. The existing Vercel
   project supplies the build command from `vercel.json`; a deployment is outside Task 12:

   ```sh
   TRACERA_PROFILE=deployed \
   TRACERA_CONFIG_ROLE=runtime \
   vp run --filter web build
   vercel deploy --prod
   ```

4. Create or select the approved Fly app, store runtime secrets through Fly's secret mechanism,
   deploy the separately reviewed worker process group, and keep one worker until the canary gates
   authorize scaling:

   ```sh
   fly secrets set \
     TRACERA_PROFILE=deployed \
     TRACERA_CONFIG_ROLE=runtime \
     DATABASE_URL=<secret-manager-value> \
     BETTER_AUTH_SECRET=<secret-manager-value> \
     AI_PROVIDER=gemini \
     AI_API_KEY=<secret-manager-value> \
     AI_MODEL=<approved-stable-model-id> \
     --app <approved-core-worker-app>
   fly deploy --app <approved-core-worker-app> --config <approved-worker-fly.toml>
   fly scale count worker=1 --app <approved-core-worker-app>
   ```

   The Fly deployment file is deliberately not checked in by Task 12: no production host has
   been selected or authorized. The file must define only the `worker` process group, omit an
   `[http_service]`, disable autostop for the worker, and run the exact worker command above.
   Fly's [deployment](https://fly.io/docs/launch/deploy/) and
   [secrets](https://fly.io/docs/apps/secrets/) documentation describes the operator actions.

## Canary scope and recovery

The current repository has no deployed v2 routing switch, so there is no executable 5% canary
command to run safely. This is an explicit blocker, not an invitation to invent an environment
variable. Before activation, Task 13 must add or configure an approved routing mechanism with the
following exact scope:

- cohort: authenticated users selected by an auditable allow-list, never anonymous or public
  traffic;
- stages: 5%, then 25%, then 100%; each stage lasts at least 24 hours and 100 completed runs;
- expansion holds on any ownership leak, unsupported citation, critical invariant incident, error
  rate above 2%, budget overrun, or unavailable worker;
- each expansion records deployed commit, migration state, cohort, start/end times, completed and
  failed runs, costs, p50/p95 latency, and recovery decision;
- a failed stage stops v2 routing and preserves all reports, evidence snapshots, calibration
  manifests, and schema versions. Recovery routes new work to the prior path; it does not roll back
  dependencies or delete data.

The exact precondition for a canary command is therefore:

```text
BLOCKED: no approved routing-switch command exists in the Task 12 codebase.
Do not enable v2, deploy shadow traffic, or promote a worker until Task 13 supplies and validates it.
```

## Storage, retention, and compatibility

- Run the additive migration history once before worker startup and record the migration journal,
  schema fingerprint, runtime grants, and database backup/restore checkpoint.
- Keep immutable v2 snapshots, assessments, provenance, replay manifests, and reports for the
  approved retention period; do not delete v1 reports or relabel v1 scores.
- Delete a user's owned run and its associated private evidence through an owner-scoped,
  auditable deletion operation. Verify no cross-tenant or public record remains before declaring
  deletion complete.
- Preserve `schemaVersion=2`, `contractVersion=2.0.0`, engine/prompt/model/retriever/embedding/
  calibration versions, and the `factual-supported-share-1.0.0` formula in every report.
- A report reuse decision must continue to require exact content, proposition scope, versions,
  visibility, owner scope, and freshness. Altered or merely similar images cannot reuse a report.

## Approval conditions

This proposal becomes actionable only after [`RELEASE-DECISION.md`](RELEASE-DECISION.md) is PASS,
the human-gold and calibration artifacts are frozen, the staging rehearsals pass, the exact model
IDs and provider capabilities are recorded, the worker host and routing switch are selected, and a
human operator authorizes the migration/deployment/canary scope. Task 12 did not perform any of
those production actions.
