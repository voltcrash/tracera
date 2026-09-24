# Core v2 Task 12 evaluation report

> **Historical context — superseded full-release evaluation.** This report records the Task 12
> full-release program only. Its blocked gates did not pass, and no full Core v2 release approval
> is claimed. It is not an active gate for Core v2 Focused implementation; use
> [`FOCUSED-PLAN.md`](FOCUSED-PLAN.md) for the active product path.

Status: **release-validation BLOCKED**. The Task 12 fixture and operational evidence are
implementation evidence only. No production traffic, shadow traffic, paid provider batch,
human-gold annotation, calibration artifact, or production database was used.

Run date: 2026-09-15
Task branch: `core-v2/task-12-release-evaluation`
Parent branch: `core-v2/task-11-unify-orchestration`
Parent tip used: `daef5bad814941280e37fb5d99732c749f727af3`
Required historical base: `6f6e28f0e384100986fcc9ed61bea6fe34233a48`
Evaluation seed: `20260910`

The historical task configuration named `6f6e28f` as the parent, but the predecessor branch and
PR #17 had already advanced to `daef5ba`. This task uses the verified pushed predecessor tip and
does not rewrite or retarget the predecessor.

## Dataset and split audit

The checked-in candidate manifest remains a collection queue, not gold data. The release target is
1,500 claims from at least 300 stories: 500 development, 500 calibration, 500 sealed test, plus a
later temporal holdout. The current counts are:

| Partition or artifact                 |         Current count | Required evidence                             | Status              |
| ------------------------------------- | --------------------: | --------------------------------------------- | ------------------- |
| Development                           |        0 / 500 claims | Two annotations and adjudication              | `not_evaluated`     |
| Calibration                           |        0 / 500 claims | Two annotations and adjudication              | `not_evaluated`     |
| Sealed test                           |        0 / 500 claims | Frozen before one release opening             | `not_evaluated`     |
| Temporal holdout                      | 0 / additional target | Cutoff and size frozen before collection      | `not_evaluated`     |
| Human-gold claims                     |                     0 | Independent annotations plus adjudication     | `BLOCKED`           |
| Event/source-family isolation fixture |                 1 / 1 | Leakage detector finds injected contamination | `PASS` fixture-only |

Hashes are kept distinct:

| Artifact                                     | Hash                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| Core invariant dataset canonical hash        | `sha256:7b4caa72a9b0fa33c1a45d0dd1782aa30d78d2fb48884c61d5890732ea63daae` |
| Core invariant dataset file bytes            | `sha256:07637959336fbb46ae8e871de15484699832a27609173a1e4f0e74a4df1fffdf` |
| Candidate dataset manifest file bytes        | `sha256:be1a138d48ddc363d17a0d9e6c1cd0dbc5ef1a5c5495eef2d95f958024b26d09` |
| Annotation queue file bytes                  | `sha256:1c04a0ea75d4a4406723496d5dc487eb2278961dfffd9846196c521c234280f0` |
| Task 12 release fixture manifest bytes       | `sha256:4aff624c8b3e3bfa0b581073d4c186f2753b4eb0aea67b9147119e0a3defe4c7` |
| Task 11 orchestration fixture manifest bytes | `sha256:6f9b86ae71343b36ff7f7f1d6b52eb9a575364ef582f8c708061b4f40a202979` |
| Task 06 retrieval replay fixture bytes       | `sha256:188ccd0ab26855340288895485b0101d5bf19e5420c6e7b16aff155c734bcf02` |

The checked-in deployment examples used for configuration review have these file-byte hashes:

| Configuration example                               | Hash                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `config/environment/deployed.runtime.env.example`   | `sha256:f2bb05fd05ca94a3ce1fa7d152289ff27ebd7ab5ab7a142285a4b8493aca1575` |
| `config/environment/deployed.migration.env.example` | `sha256:18977895ea71f21b10b3988d6598ecbc32abc0cbf999d294bc4ba7aa25dba8ea` |
| `config/environment/deployed.analysis.env.example`  | `sha256:e70ef58ecbefdf75d6afd671e792b60c25a1ca7f2c4d3470b9aa980aed395a9a` |

No generated `.tracera` configuration is a release artifact; it is worktree-specific, ignored,
and must be regenerated for each environment.

The universal Task 01 harness detected all four injected integrity violations: wrong verdict
1/1, invalid citation 1/1, future-evidence leakage 1/1, and event split contamination 1/1.
These are invariant detections, not accuracy measurements.

## Model comparison and calibration

The deployed example currently declares `AI_PROVIDER=gemini` but leaves `AI_MODEL` and
`AI_EMBEDDING_MODEL` unset. Local and test profiles reject external providers and use only the
sealed deterministic fixture. No credentials, adjudicated development labels, or authorized paid
budget were available, so no stable model candidate could be compared on development data. Model
provider and exact model identifiers are therefore **not evaluated**, not guessed.

The release calibration policy is frozen in code:

| Setting                                       | Frozen value |
| --------------------------------------------- | -----------: |
| Minimum adjudicated decisive observations     |          500 |
| Minimum observations per advertised slice     |           50 |
| Grouped out-of-fold folds                     |            5 |
| L2 regularization                             |            1 |
| Decisive precision target                     |         0.95 |
| Validity window                               |     180 days |
| Synthetic labels allowed for release artifact |        false |

The synthetic calibration attempt is expected to refuse fitting: 0/500 required adjudicated
observations and 0/5 event groups. No calibrator artifact or threshold was written, and the sealed
test partition was not opened. Any later fit must record the exact model, prompt, engine, retriever,
dataset, observation-set, configuration, git, seed, and artifact hashes before the single sealed
evaluation. Test failures must not be used for tuning; a material change requires a new holdout.

## PLAN gate ledger

`null / 0` means numerator is unavailable and denominator is zero. It is reported as
`not_evaluated`, never as a passing zero.

| PLAN gate                               | Evidence in this task                                    |                      Numerator / denominator | Status              |
| --------------------------------------- | -------------------------------------------------------- | -------------------------------------------: | ------------------- |
| Claim extraction                        | No adjudicated inventory                                 |                                   `null / 0` | `not_evaluated`     |
| Citation integrity                      | Fixture rejection paths; no held-out human audit         | `null / 0` empirical; 1 / 1 fixture detector | `BLOCKED`           |
| Evidence validity                       | No independent citation-entailment audit                 |                                   `null / 0` | `not_evaluated`     |
| Retrieval                               | Fixed/replay fixtures only; no held-out answerable cases |                                   `null / 0` | `not_evaluated`     |
| Decisive supported precision            | No human-gold published decisions                        |                                   `null / 0` | `not_evaluated`     |
| Decisive contradicted precision         | No human-gold published decisions                        |                                   `null / 0` | `not_evaluated`     |
| Coverage                                | No held-out human-gold denominator                       |                                   `null / 0` | `not_evaluated`     |
| Other verdicts / macro-F1               | No human-gold labels                                     |                                   `null / 0` | `not_evaluated`     |
| Calibration ECE / Brier / risk coverage | No fitted adjudicated calibrator                         |                                   `null / 0` | `not_evaluated`     |
| Origin                                  | No known-root held-out subset                            |                                   `null / 0` | `not_evaluated`     |
| Robustness                              | Eight Task 12 fixture cases, 18 checks                   |                  8 / 8 cases; 18 / 18 checks | `PASS` fixture-only |

Confidence intervals are `null` for every empirical metric because no valid adjudicated
denominator exists. No Wilson bound or story-cluster bootstrap result is claimed.

## Fixed, replay, live, and adversarial evidence

The Task 12 fixture evaluator is:

```sh
vp run evaluate:core-release:fixture
```

It requires `split=all` and seed `20260910`, runs with the generated test analysis profile, and
returns **8 passed, 0 failed, 0 skipped, 18 checks**. Its fixture manifest hash is
`sha256:4aff624c8b3e3bfa0b581073d4c186f2753b4eb0aea67b9147119e0a3defe4c7`. The report sets
empirical metrics to `not_evaluated`, cost to `null`, p50 runtime to `null`, p95 runtime to
`null`, and `releaseApproved=false`.

The cases are:

| Case                       | Fixture assertions                                                                    | Result |
| -------------------------- | ------------------------------------------------------------------------------------- | ------ |
| Retrieval prompt injection | Untrusted document text is data; it cannot replace the system instruction             | 2 / 2  |
| SSRF                       | Private redirect is rejected before the redirected request                            | 2 / 2  |
| Source flooding            | One shared request budget bounds discovery/fetch work and reports exhaustion          | 2 / 2  |
| Corpus poisoning           | Content hash and scope are revalidated; prior model output is not evidence            | 2 / 2  |
| Number/unit changes        | Altered denominator and unit scope are rejected                                       | 2 / 2  |
| Future leakage             | Future evidence and cross-event split contamination are detected                      | 2 / 2  |
| Missing OCR text           | Missing OCR is partial; uncertain OCR and missing visual verification remain explicit | 4 / 4  |
| Reused altered images      | Changed content cannot use exact-result reuse; similarity is not identity             | 2 / 2  |

Task 06's deterministic retrieval replay remains separate: 5/5 fixture cases, with the replay
fixture hash above. Task 11's orchestration fixture remains separate: 12/12 scenarios and 61/61
invariant checks. Neither is a stochastic provider rerun.

Matched live v1/v2 evaluation, authorized paid-run budget, development model comparison, and
independent human audits of unsupported/confident errors were not available. No cost, latency,
provider behavior, accuracy, calibration, or best-in-class comparison is claimed.

## Operational evidence

The local operational evidence is intentionally separate from staging release evidence:

| Rehearsal                                                                     | Result                                                                   | Limitation                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| Disposable Core PostgreSQL storage gate                                       | 1 file, 5 passed, 0 failed, 0 skipped                                    | Synthetic rows and disposable database         |
| Migration/privilege/runtime rehearsal                                         | 29 migrations, repeat no-op, runtime suite 6 passed, 0 failed, 0 skipped | Local disposable PostgreSQL, not staging       |
| Durable worker/orchestration fixtures                                         | 12 scenarios, 61 checks passed                                           | In-memory repository and scripted stages       |
| Browser offline/auth flow                                                     | 1 passed, 0 failed, 0 skipped                                            | Local fixture profile                          |
| Staging migration/failure/retry/backpressure/deletion/spend/routing rehearsal | Not run                                                                  | No staging host, credentials, or authorization |

The PostgreSQL storage run database and test container were cleaned up after the authoritative
gate. The exact command ledger and repository-wide results are in
[`handoffs/12.md`](handoffs/12.md).

## Current release conclusion

Implementation evidence is complete for the bounded Task 12 evaluator, release report, runbook,
and production proposal. Release validation remains **BLOCKED** by the missing human-gold corpus,
frozen adjudicated calibration, authorized live budget/provider configuration, independent audit,
staging rehearsal, and approved worker host/routing. The release decision is recorded separately in
[`RELEASE-DECISION.md`](RELEASE-DECISION.md); no deployment or shadow traffic is authorized by
this report.
