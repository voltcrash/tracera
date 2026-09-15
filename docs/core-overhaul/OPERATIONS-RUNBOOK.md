# Core v2 operations runbook

This runbook is for local and future approval-gated staging/production rehearsals. It does not
authorize live providers, production credentials, migrations, deployments, shadow traffic, or
canary traffic. The current release state is BLOCKED; use
[`RELEASE-DECISION.md`](RELEASE-DECISION.md) as the source of truth.

## Safety rules

- Use the current worktree's generated configuration only. Run `vp run env:setup`; never copy
  `.tracera`, `.env`, database URLs, ports, credentials, or reports from another worktree.
- Keep runtime, migration, and analysis environments separate. The web/worker runtime receives
  `DATABASE_URL`; only the migration operator receives `DATABASE_MIGRATOR_URL`.
- Local and test analysis must remain `TRACERA_ANALYSIS_MODE=fixture`. A fixture or deterministic
  calibrator must never enter a deployed profile.
- Do not print secrets, source text, private report content, or provider payloads into logs. Audit
  events identify the run/stage and validation result without copying untrusted document text.
- Treat `partial`, `unavailable`, `failed`, and `canceled` as distinct. A provider outage is not an
  empty successful search, and a missing calibrator is not a confidence value.
- Stop on ownership leakage, invalid citations, unsupported confident output, budget overrun,
  error rate above 2%, missing worker heartbeats, or any failed required integration suite.

## Local setup and baseline

```sh
vp install
vp run env:setup
vp run local:setup
vp run test:core-storage
vp run db:test:status
```

The Core storage gate must report exactly 5 passed, 0 failed, and 0 skipped. After cleanup,
`db:test:status` is expected to exit nonzero and say the disposable test database/container is
`not created`.

Run the fixture-only release checks with no external network or provider credentials:

```sh
vp run test:core-release
vp run evaluate:core-release:fixture
vp run evaluate:core:fixture
vp run evaluate:core-orchestration:fixture
```

The Task 12 evaluator requires `split=all` and seed `20260910`. Its 8 cases and 18 checks are
code-path evidence only. The Task 01, Task 06, and Task 11 fixture/replay reports stay separate.

## PostgreSQL and migration rehearsal

The authoritative disposable rehearsal is:

```sh
vp run db:rehearse
vp run test:core-storage
vp run db:test:status
```

The rehearsal must apply every journal migration, verify file hashes and journal timestamps, be a
repeat no-op, match the reviewed least-privilege runtime grants, run the sealed runtime suite
with no skipped tests, drop its run database, and leave no disposable test container when cleanup
is complete. This is local PostgreSQL evidence, not staging or production approval.

For an approved deployed migration, first verify the selected commit and role separation, then run
only the additive migration command from a protected operator environment:

```sh
git rev-parse HEAD
test "$TRACERA_PROFILE" = deployed
test "$TRACERA_CONFIG_ROLE" = migration
test -n "$DATABASE_MIGRATOR_URL"
test -z "${DATABASE_URL:-}"
vp run @repo/db#db:migrate
```

Do not run reset, drop, destructive SQL, or a migration command with the web/worker runtime URL.
Record the migration journal, schema fingerprint, runtime privilege audit, backup identifier, and
operator identity before starting a worker.

## Worker lifecycle

The durable worker is an independent process:

```sh
vp run worker:core
```

The local launcher requires a healthy worktree-local database. The worker uses the frozen
`RunEnvironment`, durable lease/fencing token, owner/tenant scope, checkpoints, cancellation
polling, retry path, and exact provider reservation identity. A browser disconnect is not a
cancellation request. SIGINT/SIGTERM returns unfinished work for retry; it does not publish a
canceled scorecard.

For staging, run one worker first and inject a controlled process termination while a run is in a
non-terminal stage. Verify that the lease expires or is returned, the retry keeps the same run and
reservation identity, stale fencing tokens cannot finalize, and the eventual report contains only
persisted immutable snapshots. Then run a second worker only to verify distinct lease acquisition
and bounded shared budgets. Record every run ID, attempt, fencing token outcome, retry delay, and
terminal state.

## Backpressure and spend exhaustion

Use the fixture budget and the staging provider's explicit test quota; never use a real provider
without written authorization and a dollar limit. The frozen starting caps are 120 external
requests/run, 12 discovery queries/claim, 20 fetched candidates/claim, 3 provenance hops, 2
targeted rounds, 600,000 ms elapsed, and 3 concurrent external calls.

Rehearsal acceptance:

- a source flood consumes one shared run allowance rather than multiplying a limit per stage;
- omitted queries and deferred claims are recorded with `budget_exhausted` and coverage remains
  partial;
- a provider reservation is held before an external call and settled on success, failure,
  cancellation, retry, and terminal cleanup;
- daily spend exhaustion rejects new provider work with the typed spend-limit outcome and does not
  turn the run into a successful no-evidence report;
- a retry with the same run/call identity does not reserve the same provider spend twice;
- the audit record contains enough scoped identity to reconcile reservations without logging
  untrusted text or secrets.

The existing default admission safeguards are 30 requests/user/hour, 60/IP/hour, 2 concurrent
analyses/user, 4/IP, 100 admitted/user/UTC day, a one-hour forced-reanalysis cooldown, a
600-second admission lease, and a 24-hour idempotency TTL. The proposed daily provider circuit is
`AI_DAILY_SPEND_LIMIT_USD=25`; it remains an approval-gated starting value, not measured capacity.

## Deletion and privacy verification

In staging, create two owners in separate tenants, submit private v2 runs, complete one, cancel one,
and delete both through the approved owner-scoped deletion path. Verify:

- another owner receives no run, progress, event, cancellation, evidence, or report existence;
- private snapshots, raw blobs, assessments, provenance, checkpoints, reservations, and audit
  references belonging to the deleted run are removed or retained only under an approved legal/
  audit-retention rule;
- public visibility is never inferred from a URL or a completed run;
- v1 saved reports and their historical rendering remain intact;
- deletion is idempotent and the audit record identifies the owner, tenant, run, scope, and result.

Task 12 has no staging deletion evidence; the local browser and PostgreSQL suites are regression
evidence only.

## Routing recovery and canary

The current code has no deployed v2 routing switch. Do not invent or export one during an incident.
Until Task 13 supplies and validates an approved switch, the only safe routing action is to leave
deployed v2 disabled.

After approval, the operator must use the concrete host command recorded with the selected routing
implementation and capture:

1. an authenticated, allow-listed 5% cohort;
2. 24 hours and 100 completed runs at 5% with no stop condition;
3. the same at 25%;
4. 100% only after the preceding gates pass;
5. seven days at 100% before legacy-core retirement.

On any stop condition, halt expansion, route new work to the prior path, keep all reports and
schema versions, and open a recovery record. Do not roll back dependencies or destructive-migrate
the database. Insufficient traffic extends the observation window; it does not compress the gate.

## Evidence and evaluation runbook

Before collecting any paid data:

1. Allocate stories and claims to development, calibration, sealed test, and the later temporal
   holdout by event and source family.
2. Store two independent annotations, evidence spans, scopes, verdicts, provenance expectations,
   ambiguity, and an adjudication per claim. Record license and contamination review.
3. Compare exact stable provider/model IDs on development data only. Record capability responses,
   prompt/engine/retriever versions, tokens, actual cost, latency, outages, and matched budgets.
4. Fit the frozen out-of-fold calibrator only from the calibration split:

   ```sh
   vp run @repo/ai#calibration:fit \
     --dataset evaluation/<frozen-dataset.json> \
     --observations src/core/calibration/<frozen-calibration-observations.json> \
     --seed 20260910 \
     --output <frozen-calibrator.json>
   ```

5. Verify the artifact hash and compatibility, then evaluate the sealed test exactly once:

   ```sh
   vp run @repo/ai#calibration:evaluate \
     --dataset evaluation/<frozen-dataset.json> \
     --observations src/core/calibration/<frozen-test-observations.json> \
     --artifact <frozen-calibrator.json> \
     --split test \
     --seed 20260910 \
     --sealed-release-evaluation true
   ```

6. Run fixed-evidence, retrieval replay, matched live v1/v2, and adversarial batches within the
   approved paid budget. Report numerators, denominators, Wilson bounds, clustered-bootstrap seed,
   outages, omissions, and unknowns for every PLAN gate.
7. Have an independent human audit unsupported/confident errors and record disagreements. Never
   use the implementation under test as its own gold standard.

Absent any required input, stop at that step and mark the release BLOCKED. Do not lower thresholds,
fill a missing probability, or call a fixture result accuracy evidence.

## Incident checklist

Record these fields before remediation: UTC timestamp, deployed commit, worker host/version,
run/tenant/owner IDs, stage, attempt/fencing token, report status, evidence-set hash, provider/model
ID, configuration hash, reservation ID (redacted), error/issue code, and operator. Afterward run
the relevant focused suite, storage gate, and replay check; preserve the failed artifact and its
expected-failure classification.

| Incident                           | Immediate action                                             | Do not do                                        |
| ---------------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| Worker crash or lease loss         | Allow fenced retry; inspect checkpoint and reservation audit | Finalize from a stale worker or duplicate charge |
| Provider outage                    | Keep unavailable/partial state; pause or retry under budget  | Convert an outage to no-results success          |
| Spend circuit open                 | Stop new paid work; wait for operator decision               | Raise the budget silently                        |
| Invalid citation or ownership leak | Stop canary and preserve the report/audit                    | Repair or drop the reference silently            |
| Routing failure                    | Stop expansion and route to the approved prior path          | Enable shadow traffic without approval           |
| Migration failure                  | Stop before worker startup; retain logs and backup point     | Reset or edit migration history                  |
