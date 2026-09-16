# Core v2 release decision

> **Historical context — superseded full-release decision.** The `BLOCKED` decision below applies
> to the original full-release evaluation program and remains unchanged: its gates did not pass.
> It is not a blocker for focused product implementation, and it does not authorize a production
> cutover. The active implementation plan is [`FOCUSED-PLAN.md`](FOCUSED-PLAN.md).

Decision: **BLOCKED**
Implementation status: **PASS for Task 12 deliverables**
Release-validation status: **BLOCKED**
Decision date: 2026-09-15
Evaluated stack parent: `core-v2/task-11-unify-orchestration` at
`daef5bad814941280e37fb5d99732c749f727af3`

Core v2 must not be deployed, enabled for production traffic, run in shadow mode, or presented as
best-in-class. Task 12 has prepared the release report, operational runbook, bounded adversarial
fixture evaluator, and production configuration proposal. The required human, paid/live, staging,
worker-host, and routing evidence is absent, so the task stops here as required by the plan.

## Gate decision table

| Gate                                | Decision                             | Evidence and exact limitation                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human gold and split isolation      | **BLOCKED**                          | 0/1,500 gold claims; the candidate manifest still has 0 development, 0 calibration, and 0 sealed-test claims. Synthetic leakage detectors pass 1/1 but are not gold.                                                                              |
| Development model comparison        | **BLOCKED**                          | `AI_PROVIDER=gemini` is configured only in the example; exact `AI_MODEL` and embedding model are unset, with no credentials or adjudicated development labels.                                                                                    |
| Calibration and thresholds          | **BLOCKED**                          | Frozen policy requires 500 adjudicated decisive observations and 50 per advertised slice. Synthetic fit has 0/500 observations and 0/5 event groups; no release artifact exists.                                                                  |
| Sealed test                         | **BLOCKED / NOT OPENED**             | No eligible sealed test exists. It was not opened and no failures were used for tuning.                                                                                                                                                           |
| Fixed evidence and retrieval replay | **PASS fixture-only**                | Existing fixed/replay fixtures pass, including Task 12's 8/8 cases and 18/18 checks. They do not establish accuracy or live cost/latency.                                                                                                         |
| Matched live v1/v2                  | **BLOCKED**                          | No authorized provider batch, matched evidence availability, paid budget, or v1/v2 measurements.                                                                                                                                                  |
| Required adversarial cases          | **PASS fixture-only; audit BLOCKED** | Retrieval prompt injection, SSRF, source flooding, corpus poisoning, number/unit changes, future leakage, missing OCR, and altered-image reuse each pass deterministic checks. No independent human audit of unsupported/confident errors exists. |
| Operational staging rehearsal       | **BLOCKED**                          | Local PostgreSQL, worker, browser, and fixture rehearsals pass; no staging host, credentials, provider budget, deletion rehearsal, or routing recovery evidence exists.                                                                           |
| Worker hosting and scheduling       | **BLOCKED for activation**           | A Fly Machines long-running worker proposal is concrete and current hosting documentation was reviewed, but no host is selected, configured, or authorized.                                                                                       |
| Production limits/configuration     | **PROPOSED, NOT APPROVED**           | Exact starting limits and role-separated environment are in `PRODUCTION-CONFIGURATION-PROPOSAL.md`; cost/latency frontier is not measured.                                                                                                        |

## Exact recommended starting limits

These are approval-gated proposed limits, not observed capacity and not an accuracy guarantee:

| Control                      |       Proposed value |
| ---------------------------- | -------------------: |
| External requests per run    |                  120 |
| Discovery queries per claim  |                   12 |
| Fetched candidates per claim |                   20 |
| Provenance hops              |                    3 |
| Targeted retrieval rounds    |                    2 |
| Elapsed run cap              |           600,000 ms |
| Concurrent external calls    |                    3 |
| User rate                    |            30 / hour |
| IP rate                      |            60 / hour |
| Concurrent analyses          |     2 / user; 4 / IP |
| Daily quota                  | 100 / user / UTC day |
| Forced reanalysis cooldown   |        3,600 seconds |
| Admission lease              |          600 seconds |
| Idempotency retention        |       86,400 seconds |
| Daily provider spend circuit |               USD 25 |
| Initial worker replicas      |                    1 |

The per-run hard cost ceiling remains unresolved because provider-specific cost estimates and the
cost/latency frontier are unavailable. Do not activate paid traffic until a conservative numeric
per-run ceiling is approved in addition to the daily circuit.

Actual cost: **unknown / not measured** (not zero).
p50 runtime: **unknown / not measured**.
p95 runtime: **unknown / not measured**.
Empirical accuracy, precision, recall, calibration, coverage, and improvement: **not evaluated**;
all valid empirical denominators are 0.

## Artifacts

- [`EVALUATION-REPORT.md`](EVALUATION-REPORT.md) — dataset, model, calibration, PLAN gates,
  fixed/replay/adversarial results, hashes, and limitations.
- [`OPERATIONS-RUNBOOK.md`](OPERATIONS-RUNBOOK.md) — local validation, staging rehearsal,
  worker, backpressure, spend, deletion, routing recovery, and incident procedures.
- [`PRODUCTION-CONFIGURATION-PROPOSAL.md`](PRODUCTION-CONFIGURATION-PROPOSAL.md) — proposed
  Vercel web/Fly worker topology, role-separated settings, migration/deployment commands, canary
  scope, and recovery rules.
- `packages/ai/evaluation/release-fixtures.json` — 8-case synthetic manifest, bytes hash
  `sha256:4aff624c8b3e3bfa0b581073d4c186f2753b4eb0aea67b9147119e0a3defe4c7`.
- `packages/ai/scripts/evaluate-core-release.ts` and
  `packages/ai/scripts/support/release-scenarios.ts` — fixture-only evaluator and bounded
  assertions. It refuses live/replay modes until prerequisites are authorized.
- `packages/ai/test/core-release-evaluation.test.ts` — 8 fixture tests.

## Approval-gated commands

No command below was executed against production. They are recorded so a later authorized task can
review exact scope before execution:

```sh
# Migration role only; DATABASE_URL must not be present.
TRACERA_PROFILE=deployed TRACERA_CONFIG_ROLE=migration \
  vp run @repo/db#db:migrate

# Web build/deploy, after the migration review and release approval.
TRACERA_PROFILE=deployed TRACERA_CONFIG_ROLE=runtime \
  vp run --filter web build
vercel deploy --prod

# Separate long-running worker, after the host and routing switch are approved.
fly deploy --app <approved-core-worker-app> --config <approved-worker-fly.toml>
fly scale count worker=1 --app <approved-core-worker-app>
```

There is currently no executable canary-routing command in the repository. Task 13 must supply an
auditable authenticated allow-list switch for 5% → 25% → 100%, with at least 24 hours and 100
completed runs at each step, and a recovery command that routes new work to the prior path while
preserving reports and schema versions. Until then, the exact safe action is **do not enable v2**.

## Reopen conditions

Reopen this decision only when all of the following are recorded in one immutable release bundle:

1. 1,500+ independently adjudicated claims from 300+ event/source-isolated stories, with required
   category and language slices and a later temporal holdout;
2. development-only stable model comparison with exact provider/model/capability, cost, latency,
   outage, and matched-budget records;
3. an out-of-fold calibration artifact fitted only on the frozen calibration split, with exact git,
   configuration, dataset, observation, seed, compatibility, artifact, and threshold hashes;
4. one sealed-test opening with all PLAN gate numerators, denominators, confidence intervals,
   omissions, outages, and unknowns, without tuning on test failures;
5. authorized fixed-evidence, replayed retrieval, matched live v1/v2, and adversarial runs plus an
   independent human audit of unsupported/confident errors;
6. staging evidence for additive migration, worker failure/retry, backpressure, deletion, spend
   exhaustion, routing recovery, and the selected host limits;
7. approved production worker, role-separated secrets, per-run spend ceiling, routing switch,
   canary cohort, rollback procedure, and an operator authorization record.

Until those conditions are met, this BLOCKED decision is the correct release outcome. NEXT_TASK is
not authorized to perform a production cutover from this task.
