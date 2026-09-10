# Agent execution prompts

Use the universal prompt plus one task block. The plan is authoritative for implementation choices; task blocks specify ownership, work order and completion evidence. Paths below are repository-relative. These are prompts for future tasks; no agents have been dispatched by creating this document.

## Universal prompt — prepend to every task

```text
Implement only the numbered Tracera core-overhaul task appended below.

Read AGENTS.md, all applicable nested instructions, docs/core-overhaul/PLAN.md,
and this task's predecessor handoffs. Work in /home/lakshmi/Developer/projects/tracera.
Follow the frozen contract-manifest.md once task 02 creates it. Do not redesign
verdict semantics, score formula, stage boundaries, gates or ownership scope.

1. Inspect git status and branch. Preserve unrelated edits. Read the actual code
   and package scripts before changing them. Run vp install before starting and
   after incorporating remote changes. Use Vite+ and the latest Node LTS; inspect
   vp env doctor if setup is wrong. Do not upgrade unrelated dependencies.
2. Verify predecessor artifacts and their stated gates. If a required contract,
   credential, annotation or hosting capability is absent, complete independent
   work and record the exact blocked deliverable. Never invent evidence, labels,
   benchmark results, working infrastructure or approval. No placeholder may
   execute in production. Do not silently expand scope to repair a predecessor.
3. Implement the ordered checklist within the owned paths. Shared exports,
   configuration and package scripts may change only as necessary to wire that
   task; explain every shared-file change. Do not replace authentication, tenant
   rules, publication consent or spend controls.
4. Keep all factual decisions tied to immutable evidence snapshots. Implement
   PLAN.md's partial/unavailable states, cancellation and audit requirements.
   Do not weaken a gate to make the task pass. Minimal tests must demonstrate
   listed accuracy/security invariants, not mirror implementation details.
5. Run vp check, vp test --run and vp run check-types. Run vp run build for API,
   UI or export/integration changes. Run the task-specific evaluation through
   its vp run script. Read applicable Next.js local docs before web changes.
   For documentation-only tasks run repository checks, but do not claim live
   evaluation happened. Record failures and whether they predate your change.
6. Write docs/core-overhaul/handoffs/NN.md: exact changes, contract/API examples,
   migration/config steps, commands and outcomes, fixture/live distinction,
   metric numerators/denominators, unresolved blockers and successor instructions.
   Record the parent commit there; report the final commit in your final reply.
7. Commit each completed validated task-sized change with a single-line
   Conventional Commit and no co-author. Push to the configured task branch;
   verify all configured push destinations or report individual failures.
   Do not force-push, bypass checks or commit someone else's edits.
8. Finish with PASS or BLOCKED, changed files, checks, commit/push results and
   the specific next task. A working implementation with missing empirical
   evidence may be implementation-complete but is not release-approved.

Do not start another agent, another task, a production migration or a deployment.
Do not purchase/provision services or run paid batches without explicit scope
and budget authorization. Work autonomously on reversible implementation.
```

## 01 — Establish truth labels and the measurement harness

**Own:** `packages/ai/evaluation/`, new `packages/ai/scripts/evaluate-core.ts`, evaluation fixtures, corresponding AI package script, `docs/core-overhaul/handoffs/01.md`.

```text
1. Inventory current pipeline entry points and run the existing deterministic
   tests. Preserve the six existing model-validation cases and their runner.
2. Create a versioned annotation guide implementing PLAN.md labels. Include
   examples for attribution, time changes, misleading context, conflicting
   evidence, unanswerable claims, and origin uncertainty. Define materiality
   and an adjudicated gold claim inventory before measuring extraction recall.
3. Define dataset schemas for documents, gold claims, excerpts, origin labels,
   languages, as-of times, event/source-family groups, split IDs, annotators,
   adjudication and licensing. Add split-leakage validation and content hashes.
4. Implement a version-neutral evaluation adapter interface and v1 adapter.
   Create vp run @repo/ai#evaluate:core with explicit fixture/replay/live modes,
   split selection, seed, JSON output and nonzero gate-failure exit status.
   Fixture mode must need no network, provider credentials or production DB.
5. Implement PLAN.md metrics, Wilson bounds and clustered bootstrap. Keep
   extraction matching evidence auditable; unresolved automatic matches need
   human review. Treat missing data/zero samples as not evaluated, never pass.
6. Add only the necessary synthetic invariant fixtures and a candidate dataset
   manifest. Mark synthetic/model labels non-gold. If external benchmark data
   is available, inspect license and label mapping before importing it.
7. Produce a baseline report from available data, explicitly separating code
   smoke results from empirical accuracy. Produce an annotation queue meeting
   PLAN.md's allocation; do not claim the human corpus exists until it does.
```

**Pass:** fixture harness detects deliberately wrong verdicts, invalid citations, temporal leakage and split contamination; output includes denominators and dataset hashes. Human dataset completion may remain a release blocker while task 02 proceeds.

## 02 — Freeze v2 contracts and deterministic stage interfaces

**Own:** `packages/contracts/src/core-v2.ts`, contracts export, `packages/ai/src/core/types.ts`, `docs/core-overhaul/contract-manifest.md`.

```text
1. Implement all PLAN.md entities with runtime validation, explicit nullable
   values, discriminated statuses, reason codes and versioned public reports.
2. Define ports for generation, embeddings, search, document acquisition,
   snapshot/run storage, clock and audit; core logic may not import DB globals
   or read process.env. Reuse provider adapters behind these ports.
3. Specify exact signatures for normalizeInputV2, extractClaimsV2,
   retrieveEvidenceV2, assessEvidenceV2, traceOriginsV2, adjudicateClaimsV2,
   calibrateDecisionsV2, scoreReportV2 and runAnalysisV2.
4. Encode citation-reference, offset, count and score-range validation.
   Distinguish diagnostic uncalibrated decisions from publishable decisions.
5. Publish canonical examples for complete, partial, unavailable, ambiguous,
   canceled, no-claim and legacy-report cases. Freeze the manifest and update
   evaluation adapter typing. Leave legacy contracts operational.
```

**Pass:** schemas reject dangling citations and inconsistent/null score states; existing consumers type-check unchanged. No optional “anything JSON” escape hatch for core evidence objects.

## 03 — Add immutable evidence and durable run storage

**Own:** `packages/db/src/core/`, additive Drizzle schema/migrations, `packages/ai/src/core/storage.ts`, DB exports.

```text
1. Add runs, stage attempts/checkpoints, snapshots, claims, evidence assessments,
   provenance edges, report versions and outbox/job records. Use indexes and
   uniqueness constraints for idempotent stage writes and snapshot identity.
2. Store bounded normalized snapshots in Postgres initially with hashes and
   locators; make raw binary/blob storage a port with an explicit unavailable
   state. Do not silently truncate evidence or pretend a hash is a snapshot.
3. Implement transactional enqueue, lease acquisition/renewal, fencing tokens,
   retries with backoff, cancellation and atomic report finalization. Require
   attempt+fencing checks so an expired worker cannot overwrite its successor.
4. Enforce owner/visibility filtering on every read and write, including corpus
   and replay paths. Share public source content only when publication policy
   permits it; do not expose private submission text in shared caches.
5. Version model/prompt/retriever/calibration identities and embedding model,
   dimensions and preprocessing. Never compare incompatible vectors; retain
   existing 1024-dimensional storage until an explicit reindex migration exists.
6. Generate migrations using the repository's vp run DB generation script.
   Rehearse on a disposable DB when available; do not migrate production.
   Document retention/deletion behavior for snapshots referenced by reports.
```

**Pass:** necessary integration fixtures cover duplicate enqueue, crash/retry, stale-worker fencing, atomic completion and cross-tenant denial. Missing disposable DB is reported as an integration-validation blocker.

## 04 — Rebuild faithful input acquisition, including images

**Own:** `packages/ai/src/core/ingestion/`; reuse `safe-fetch.ts` without weakening it.

```text
1. Implement structured HTML extraction preserving headings, paragraphs, tables,
   captions and source locators; retain raw/normalized hashes and extraction
   provenance. Detect anti-bot/error pages even when HTTP returns 200.
2. Handle provided text, public links and images through the frozen input port.
   Apply bounded response size, MIME checks, redirect/DNS restrictions and
   cancellation. Reader fallback must retain its identity and limitations.
3. Replace URL-slug-as-fact behavior with discoveryHint plus content_unavailable.
   Record truncation/unsupported formats explicitly; chunk readable long input
   with stable offsets rather than silently taking the first 50,000 characters.
4. OCR images with region boxes and uncertain transcription flags. Keep visible
   text, user captions and inferred visual assertions distinct. Never turn a
   guessed person/location/date into a factual claim. No model OCR confidence
   may be described as calibrated without validation.
5. Add capability ports for reverse-image retrieval and content credentials.
   A generated search link is not a performed reverse search. If no validated
   connector exists, mark visual provenance unverified; do not certify image
   authenticity from OCR, EXIF, missing metadata or a manipulation heuristic.
```

**Pass:** fixtures cover blocked page, misleading slug, long text, numeric table, redirect rejection and OCR ambiguity. An input with unavailable original content cannot yield a full article score.

## 05 — Extract a complete, scoped claim inventory

**Own:** `packages/ai/src/core/claims/`.

```text
1. Implement overlapping paragraph-aware chunk extraction and a document-wide
   inventory merge. Exact source spans must be validated before accepting claims.
2. Split conjunctions and numerical propositions while preserving necessary
   qualifiers, attribution, negation, time and units. Resolve pronouns only
   from explicit local context; otherwise mark needs_context.
3. Keep canonical claim identity separate from paraphrase retrieval text.
   Deduplicate only semantically equivalent propositions with identical scope;
   retain source occurrences and parent relations without double scoring.
4. Add a coverage audit mapping every substantive input segment to claims or an
   explicit opinion/background/non-checkable/deferred disposition. Audit omission
   against the entire document, not only against already extracted claims.
5. Remove fixed-three-claim assumptions in v2. When budgets prevent full analysis,
   persist all inventoried claims and expose deferred processing and partial status.
6. Wire extraction evaluation to adjudicated inventory; do not use the extractor
   to grade itself. Return no-claim status for opinion-only content.
```

**Pass:** long multi-claim, attribution-versus-truth, negation, entity collision, denominator, non-English/unsupported and duplicate fixtures preserve scope. Report precision/recall only where gold exists.

## 06 — Build evidence retrieval around answerable questions

**Own:** `packages/ai/src/core/retrieval/` and discovery adapters.

```text
1. Generate neutral, supporting and disconfirming queries using scoped claim
   fields; include primary-document and date-constrained queries. Treat quoted
   text and translated queries as traceable transformations, not new facts.
2. Wrap existing search providers as candidate generators. Add a generic web
   search port and primary-source resolver; missing capabilities are explicit.
   Verify current official API docs before integrating a new provider.
3. Separate discovery, fetching, extraction, passage selection and reranking.
   Acquire immutable full relevant documents before marking excerpts admissible.
   Search snippets/ratings remain candidates when fetch fails.
4. Retrieve original evidence from corpus matches and revalidate content/scope;
   exclude prior model reasoning from admissible support. Enforce tenant scope.
5. Implement PLAN.md's global budget and per-claim caps. Reserve acquisition and
   counterevidence capacity before discovery exhausts the run. Log each query,
   result, rejection, fetch error, omission, cost and stopping reason.
6. Use sufficiency feedback for at most two targeted rounds. Keep a bounded
   passage candidate pool; lexical overlap alone must not be the final gate.
   Distinguish complete no-results, unsupported capability and provider outage.
```

**Pass:** replay fixtures include strong evidence outside news, a contradicted claim, historical evidence, API outage and exhausted budget. No snippet-only document is admitted as decisive evidence.

## 07 — Validate entailment and source independence

**Own:** `packages/ai/src/core/evidence/`.

```text
1. For every claim/passage pair, generate a structured relation plus exact quote
   and scope checks. Validate substring/offset identity mechanically; reject
   invalid IDs or invented quotes instead of silently dropping them.
2. Assess temporal/entity/jurisdiction applicability and primary/secondary
   directness. Check quantities, units and denominators with deterministic
   calculations when the required operands are present; store calculation steps.
3. Identify canonical duplicates, copied/syndicated passages, wire attribution
   and citation dependence. Retain supporting locators for each dependence edge.
   Domain diversity alone cannot establish independence.
4. Represent unknown dependence and uncertain applicability explicitly. Preserve
   conflicting evidence. Submitted assertions and corpus verdicts cannot be
   counted as independent support for the underlying claim.
5. Implement the challenge-input builder using claim plus admissible evidence
   without a draft label. Store structured justifications, not private model
   chain-of-thought. Export the sufficiency feedback used by task 06.
```

**Pass:** fixtures reject wrong-person, wrong-year, quoted false allegation, altered denominator, fake source ID and fake excerpt; ten syndicated copies count as one known origin group.

## 08 — Replace Ground Zero with claim-level provenance

**Own:** `packages/ai/src/core/provenance/`.

```text
1. Build one graph per scoped claim. Traverse explicit citations and attributed
   originals through the retrieval controller within three hops and shared caps.
2. Preserve typed publication/update/event/index/archive timestamps as intervals
   with provenance and timezone/precision. Unknown dates remain unknown.
3. Add archive lookup through a port, record unavailable lookups, and validate
   that the relevant claim appears in captured content before using the capture
   as claim-level existence evidence. URL capture alone is document history.
4. Detect chronology conflicts and cycles. Rank admissible roots with explicit
   signals, distinguishing the primary record, earliest observed statement and
   earliest retrieved report. Do not force a unique root for ties or conflicts.
5. Emit candidates, supporting graph edges, searched sources/date range and
   unresolved limits. Always use earliest-observed wording in output.
6. Feed newly acquired evidence back through assessment before final decisions.
```

**Pass:** known citation chain, backdated update, archive-before-declared-date, simultaneous sources, syndication, citation cycle and inaccessible-original fixtures behave according to PLAN.md. Origin uncertainty does not become a truth penalty.

## 09 — Rebuild adjudication and confidence

**Own:** `packages/ai/src/core/adjudication/`, `packages/ai/src/core/calibration/`, calibration artifacts/scripts.

```text
1. Implement PLAN.md's five-label policy over validated assessments. Require
   reason codes and evidence references for all material factual justifications.
2. Reject decisive output without admissible applicable evidence, or with failed
   citation checks. Insufficient evidence becomes unverified with exact reasons.
3. Independently challenge each proposed decisive verdict without revealing its
   draft label first. Disagreement invokes one targeted search/reassessment;
   persist unresolved conflict without forcing consensus or majority voting.
4. Integrate the specified correctness calibrator and calibration-scope checks.
   Build fitting/evaluation scripts through vp run, with dataset/version hashes
   and leakage validation. Never fit against the sealed test partition.
5. Keep raw model confidence diagnostic only. Calibration artifact missing,
   invalidated or outside its supported slice means null calibrated confidence
   and an unverified publishable decision; preserve raw diagnostic decisions for
   evaluation so annotation/calibration can proceed without circular dependencies.
6. Freeze thresholds only from calibration data. If human data is missing,
   complete implementation and fixture verification, mark release BLOCKED.
```

**Pass:** fixtures demonstrate deterministic abstention, genuine contradiction, misleading corrective context, unresolved conflict and stale-calibration rejection. Publish empirical confidence claims only after held-out evaluation.

## 10 — Replace scoring and framing

**Own:** `packages/ai/src/core/scoring/`, `packages/ai/src/core/framing/`.

```text
1. Implement exactly PLAN.md's factual score formula, denominator, null policy,
   equal deduplicated weights and coverage thresholds as versioned pure functions.
2. Return verdict counts and omitted/deferred claims; keep mixed/misleading and
   unverified visible. Do not assign fractional truth values to these labels.
3. Separate text-observed language findings from evidence-backed omissions/skew.
   Findings reference exact submitted spans; corrective-context findings also
   reference assessed evidence. Tone alone cannot imply factual falsehood.
4. Preserve observed negative news and attributed quotations without automatic
   penalties. Remove v2's legacy loaded-word fallback and omnibus average.
5. Record evidence sufficiency, time applicability and provenance independently;
   no new arbitrary weighted quality percentage. Do not mutate domain trust.
```

**Pass:** zero-claim/all-unknown/partial reports return null score; copied evidence and style changes cannot boost accuracy; all-contradicted resolved claims yield zero, all-supported fully resolved claims yield 100; material mixed/misleading blocks the summary score.

## 11 — Unify orchestration and integrate reports

**Own:** `packages/ai/src/core/run-analysis.ts`, worker entry point, shared exports, web integration, v2 reuse policy.

```text
1. Compose the frozen stages into runAnalysisV2 with checkpoint hashes and
   invalidation of downstream stages after changed evidence/configuration.
   Add a vp run worker script that consumes durable jobs and supports shutdown.
2. Route v2 HTTP submission to durable enqueue and return run ID/status. Implement
   authenticated progress polling/streaming and reconnect/cancel semantics.
   Browser disconnect must not accidentally cancel a durable job; explicit user
   cancellation must propagate and release spend/lease resources safely.
3. Preserve existing consent, authentication, quotas, idempotency and spend
   controls. Tie retries to the same reservation without double charging or
   marking unfinished work complete. Keep a v1 route/flag until cutover.
4. Replace v2 URL-only and semantic-image result reuse with content hash,
   proposition scope, engine/config/embedding/calibration versions, visibility
   and freshness compatibility. Re-fetch changed URLs. Similar images/stories
   are related context only. Prevent related-story links from implying identity.
5. Add version-discriminated API and UI reports: evidence excerpt links, claim
   coverage, deferred work, null scores, conflict, as-of time, origin candidates,
   and clear OCR-versus-visual verification status. Preserve v1 report rendering.
6. Make CLI/evaluation/web consume the same engine. Keep all model calls out of
   report rendering. Write a replay command that recomputes deterministic decisions
   from persisted artifacts; distinguish replay from stochastic model reruns.
```

**Pass:** end-to-end fixture covers submit, disconnect, resume, crash/retry, cancel, cached repeat, URL content change and old-report rendering. Owner isolation holds for progress and evidence routes. Run web build and required checks.

## 12 — Evaluate, challenge and prepare the release decision

**Own:** evaluation reports, operational runbook, explicit production configuration proposal; fix regressions through bounded follow-up tasks.

```text
1. Verify human gold and split isolation. Compare latest stable configured model
   candidates on development data only; evaluate cost/latency/accuracy profiles.
   Record provider/model identifiers and official capability documentation.
2. Fit/freeze calibration and thresholds. Record git/config/dataset hashes.
   Open the sealed test once for release evaluation; do not tune on its failures.
   Subsequent improvements need a fresh sealed holdout for final approval.
3. Run fixed-evidence, replayed retrieval, matched live v1/v2 and adversarial
   evaluations within an explicitly authorized paid-run budget. Report all
   PLAN.md gates and slices with confidence intervals and unknowns.
4. Include cases for retrieval prompt injection, SSRF, source flooding, corpus
   poisoning, number/unit changes, future leakage, missing OCR text and reused
   altered images. An independent human audits unsupported/confident errors.
5. Rehearse additive migration, worker failure/retry, backpressure, deletion,
   spend exhaustion and routing recovery in staging. Verify hosting limits from
   official current docs; provide a concrete worker hosting/scheduling proposal.
6. Produce RELEASE-DECISION.md with PASS/BLOCKED per gate, exact recommended
   production limits, actual cost/p50/p95 runtime, artifacts and unresolved risks.
   Include the exact migration/deployment/canary commands and scope for approval.
   Do not deploy, enable shadow traffic or claim best-in-class without a matched
   comparison proving that narrower claim. Stop if required inputs are absent.
```

**Pass:** every release gate is evidenced, operational rehearsal succeeds and the release proposal is concrete. Missing annotation, credentials, paid-run authorization or hosting makes release BLOCKED; it is not a reason to fabricate measurements.

## 13 — Cut over and retire the obsolete core

**Own:** approved deployment configuration, obsolete v1 generation code, compatibility docs and final evidence inventory.

```text
Precondition: task 12 passes and the user authorizes the concrete release proposal.
1. Verify deployed configuration matches the frozen release manifest. Apply the
   approved additive migrations and start the supported durable worker.
2. Follow PLAN.md's staged canary and stop/revert routing on its failure rules.
   Keep existing dependency versions and all historical reports intact.
3. After the full rollout observation window, remove v1 claim extraction,
   retrieval, verdict/scoring/origin generation and duplicated orchestration.
   Retain only versioned legacy decoding/rendering needed for saved reports.
4. Update scripts/docs/exports so no production call reaches retired code. Use
   repository-wide import/reference searches, checks, tests and build to verify.
   Replace obsolete behavior tests with v2 semantic assertions only where the
   requirement changed; never remove safety tests just to pass validation.
5. Record deployed commit, canary outcomes, observation dates, migration state,
   archived baseline artifacts, recovery steps and remaining measured limits.
```

**Pass:** v2 serves production within approved gates; all old reports still load; legacy core execution paths are gone. A stopped rollout is not task completion. Do not compress observation windows into a single session or pretend traffic occurred.
