# Tracera core rebuild specification

Status: implementation plan, not an implemented or validated system. Prepared 2026-09-10.

## Objective and boundaries

Replace the tracing, claim analysis, evidence evaluation, and scoring core. Optimize for evidence-backed correctness and useful coverage, with measured uncertainty. Preserve authentication, ownership, publication consent, spend controls, saved reports, and working provider adapters unless a specified integration requires changes.

Perfect accuracy and exhaustive discovery of the entire web cannot be promised. Missing evidence, inaccessible originals, uncertain dates, ambiguous claims, and distribution shift remain possible. The product must expose those limits instead of converting them into confident verdicts. Agents must follow this specification; when required evidence, credentials, annotation, or infrastructure is unavailable, they must report a concrete blocker rather than invent a successful result.

This plan authorizes implementation work when assigned to a future agent. It does not itself start agents, provision services, run paid evaluations, migrate production, or deploy. Dependency versions and hosted service capabilities must be verified from current official documentation at implementation time. Do not select a model merely because it is newer or described as more capable: evaluate the latest stable candidates available through configured providers.

## Findings in the existing implementation

These are code observations, not measured production error rates. Paths are relative to the repository root.

| Location                                                                     | Observed behavior                                                                                                    | Required replacement                                                                                           |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/ai/src/pipeline/extract-claims.ts`                                 | Schema and output capped at three claims; lexical grounding accepts 60% term overlap                                 | Full claim inventory, exact input spans, semantic fidelity and coverage accounting                             |
| `packages/ai/src/pipeline/normalize-input.ts`                                | Regex article extraction, 50,000-character truncation, URL slug recovery as a headline                               | Structured document extraction and explicit partial/unavailable states; slug is a discovery hint only          |
| `packages/ai/src/pipeline/retrieve-sources.ts`                               | Five external requests and five evidence sources; news-first discovery; snippets can survive failed enrichment       | Separate discovery from fetched admissible evidence; claim-driven primary-source and counterevidence retrieval |
| `packages/ai/src/pipeline/retrieve-sources.ts`                               | Corpus sources contain previous verdicts/reasoning                                                                   | Corpus proposes original evidence; previous model outputs never corroborate themselves                         |
| `packages/ai/src/pipeline/score-claim.ts`                                    | Model emits verdict and confidence; unknown source IDs are silently dropped; no excerpt-level entailment enforcement | Validated evidence assessments, citation integrity, deterministic abstention, held-out calibration             |
| `packages/ai/src/pipeline/score-claim.ts`                                    | Evidence quality averages count, recency, credibility, and relevance                                                 | Auditable dimensions, temporal applicability, dependency-aware evidence sufficiency                            |
| `packages/ai/src/pipeline/aggregate-score.ts`                                | Unverified maps to 0.5; overall averages factual accuracy with reputation, framing, corroboration, evidence quality  | Factual score with explicit eligible denominator and coverage; other dimensions reported separately            |
| `packages/ai/src/pipeline/ground-zero.ts`                                    | Orders retrieved timestamps; treats different domains as independent; archive lookup limited to two URLs             | Per-claim provenance graph, date uncertainty, citation traversal and explicit origin search coverage           |
| `packages/ai/src/pipeline/analyze-framing.ts`                                | Text-only model scores include factual skew/context omission                                                         | Separate language observations from evidence-backed material context findings                                  |
| `apps/web/src/server/index.ts` and `packages/ai/src/pipeline/verify-text.ts` | Two orchestration paths; web path also handles embeddings, tracing and persistence                                   | One shared engine with durable stage execution and thin HTTP adapters                                          |
| `apps/web/src/server/index.ts`, `packages/db/src/index.ts`                   | URL/raw-input reuse and semantic image reuse; corpus/lineage retrieval; optional verdict-driven domain updates       | Content/version-aware cache, conservative identity, independently sourced reputation records                   |
| `packages/ai/evaluation/README.md`                                           | Six fixed-evidence model-validation cases                                                                            | Retain smoke coverage; add separate end-to-end retrieval, origin, calibration and adversarial evaluation       |

Existing retrieval comments refer to Worker/free-plan subrequest limits while the README describes Vercel. Verify actual infrastructure; do not carry these comments forward as runtime requirements.

## Fixed architecture decisions

Implement v2 under `packages/ai/src/core/`. Keep legacy code callable only through an explicitly versioned compatibility boundary until cutover. All production and evaluation callers use `runAnalysisV2`; the HTTP server must not implement its own extraction/retrieval/scoring sequence.

Pipeline order:

1. Capture and normalize immutable input documents.
2. Inventory factual propositions, resolve local context, record coverage.
3. Build retrieval questions and search plans for every checkable proposition.
4. Discover, fetch, snapshot, and index evidence documents.
5. Assess claim/evidence relationships and source dependencies.
6. Traverse claim-specific provenance and chronology.
7. Adjudicate verdicts; run challenge checks on decisive verdicts.
8. Apply calibrated confidence/abstention rules.
9. Compute factual score, coverage, and separate presentation findings.
10. Persist a versioned report and its replay manifest; project it into API/UI views.

Stages 5 and 6 share immutable documents. Stage 6 may request additional documents through the same retrieval controller. Additional evidence must be assessed before final adjudication. Freeze the evidence-set hash before final scoring; new documents invalidate dependent assessments. No stage may mutate a completed snapshot.

Use bounded, resumable jobs backed by Neon Postgres: transactional enqueue/outbox, leased jobs, checkpoints and fenced completion. A worker process runs independently of a browser request. Local worker execution must be available; production scheduling must use a documented supported hosting mechanism. Do not rely on a detached promise continuing after an HTTP response. Missing worker hosting blocks production activation, not implementation of the engine.

## Contract to freeze in task 02

Export runtime Zod schemas and inferred TypeScript types from `packages/contracts/src/core-v2.ts`; retain v1 exports. Create a checked-in `contract-manifest.md` with exact schema names, stage signatures and canonical JSON examples. Downstream tasks must import these types and may not invent parallel models.

| Entity             | Required fields and semantics                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RunContext         | run ID, tenant/visibility, input hash, as-of time, engine/prompt/model/retriever/calibration versions, execution mode, budget, cancellation and audit sink                                                                 |
| DocumentSnapshot   | ID, content hash, original/final/canonical URLs, acquisition time, MIME/language, immutable normalized text, extraction status, byte/character limits, locator map, timestamp assertions and their sources                 |
| Claim              | ID, text, source document and exact spans, subject/predicate/object representation, attribution, negation, quantities/units, time/place, unresolved context, checkability, parent/duplicate links and coverage disposition |
| EvidenceCandidate  | discovery query/provider/rank/time, proposed URL, discovery metadata; never admissible by itself                                                                                                                           |
| EvidenceAssessment | claim ID, snapshot ID, exact excerpt offsets/quote, relation `supports/contradicts/context/irrelevant/insufficient`, applicability, directness, dependency group, method/model/version, validation status                  |
| ProvenanceGraph    | claim ID, document nodes, typed edges with supporting locators, timestamp intervals and source types, candidate roots, search log, unresolved/conflicting chronology                                                       |
| Decision           | claim ID, label, reason codes, supporting/contradicting assessment IDs, concise evidence justification, challenge result, calibrated correctness probability or null, calibration applicability                            |
| Scorecard          | nullable factual score, eligible/resolved/unresolved counts, coverage, verdict distribution, separate evidence/presentation/origin fields, formula version                                                                 |
| RunReport          | schema version 2, engine version, status, stage outcomes, claims/decisions/scorecard/provenance, input coverage, unresolved reasons, evidence-set hash, replay manifest, cost/latency summaries                            |

Use stable content-derived IDs where identity is immutable; do not use model-generated IDs. Preserve original text alongside any normalized representation. Define offsets as half-open JavaScript UTF-16 code-unit ranges into snapshot text; image OCR also needs bounding boxes and page/frame IDs. Store explicit null/unknown rather than fabricated timestamps, scores or confidence.

Every stage returns `{status, data, issues, metrics}`. Status is `complete`, `partial`, `unavailable`, or `failed`; cancellation is a separate terminal run state. Typed issues distinguish missing evidence from provider failure, unsupported format/language, ambiguous input, truncation and budget exhaustion. A failed retrieval cannot masquerade as a completed no-evidence search.

## Non-negotiable accuracy rules

- Extract every material factual proposition within supported limits. Prioritize evaluation order when necessary, but enumerate deferred claims and mark coverage incomplete. Never silently drop beyond a fixed claim count.
- Exact spans prove the claim is grounded in the input; they do not prove truth. Preserve attribution: “X said Y” and “Y is true” are different propositions.
- URL slugs, search snippets, LLM knowledge and earlier Tracera verdicts are discovery/context only. Decisive factual evidence requires an acquired document and validated excerpt. A fetched original fact-check article can qualify; its search API rating alone cannot.
- The submitted document can prove what it says. It cannot independently corroborate its own underlying assertion. An authentic official document can directly support an appropriately scoped claim about that document; provenance and entailment are still required.
- Count underlying information origins, not domains or URLs. Syndicated copies and circular citations do not create independent support. Unknown dependence is recorded, not assumed independent.
- Check identity, time, jurisdiction, units, denominator, negation, attribution and numerical calculation before accepting entailment. Distinguish factual conflict from different dates or scopes.
- Search for disconfirming evidence as well as support. Absence of search results is not contradiction. A justified closed-world dataset can establish absence only with explicit scope/completeness evidence.
- Historical evidence is not weak merely because it is old. Relevance is assessed against the claim's time. Publication, update, discovery, event and archive times remain separate.
- “Earliest observed source” is relative to search scope. Never assert a global first source. An archive capture establishes observed existence by that time, not an exact publication date.
- Corpus retrieval is tenant-scoped. Similarity is candidate generation, never identity or truth. Reuse requires matching proposition, temporal scope, content, permissions and compatible versions plus valid freshness.
- Untrusted articles/images cannot issue instructions, change tools, or override schemas. Tools accept validated engine-generated arguments. Preserve and regression-test the existing safe-fetch protections.
- LLM votes are correlated judgments, not independent evidence. Model-reported confidence is not a calibrated probability. Unknown calibration support means null confidence and abstention from decisive production output.
- No verdict-based automatic domain-trust refinement in v2. Keep historical audit records. Any future reputation model needs independently adjudicated outcomes and a separate evaluation.

## Verdict and score policy

Use the existing labels with precise v2 semantics:

| Label        | Rule                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| supported    | Admissible evidence entails the full scoped assertion; challenge is resolved; calibrated release threshold met                                |
| contradicted | Admissible evidence entails the incompatible scoped assertion; challenge is resolved; calibrated release threshold met                        |
| misleading   | Evidence demonstrates a specific material distortion, with both the stated assertion and corrective context cited; tone alone never qualifies |
| mixed        | Material, applicable support and contradiction remain unresolved; do not use as a substitute for decomposing compound claims                  |
| unverified   | Available evidence or interpretation is insufficient; attach a typed reason                                                                   |

Confidence means probability that the emitted label is correct under the annotation policy, not the probability the proposition is true. Keep both concepts distinct. Contradictory credible evidence or reviewer disagreement triggers one targeted retrieval round and independent reassessment; unresolved conflict remains mixed/unverified. Independent reassessment receives evidence and claim before seeing the draft verdict to limit anchoring.

V2 factual score is `100 * supported / (supported + contradicted)` across deduplicated, equally weighted, fully resolved factual propositions. Other labels are excluded and shown explicitly; never map them to fractional truth. Its UI label is “Supported share of resolved claims,” not universal credibility or probability of truth.

Expose `resolutionCoverage = (supported + contradicted) / eligibleFactualClaims` and input extraction coverage separately. Return null score when the denominator is zero, input/extraction is partial, resolution coverage is below 0.80, or any material misleading/mixed claim remains. The 0.80 threshold is a provisional product gate, not a proven optimum. Every displayed number must include counts and the formula version. Unsupported/opinion-only input receives “No checkable factual claims,” never zero accuracy. Changing tone, source brand or adding syndicated copies must not change the factual score when decisions are unchanged.

Do not compute a new omnibus truth/style/reputation average. Evidence sufficiency, source provenance, presentation findings and temporal applicability have separate fields. Do not attach statistical population confidence intervals to an article's small, dependent claim count.

## Evaluation and release gates

All numeric targets below are proposed engineering gates, not achieved results or literature-backed guarantees. Freeze targets and label policy before opening the sealed test set. Failure means improve the system or document a proposed policy change; agents cannot lower thresholds to pass.

Use three isolated partitions: development, calibration, and sealed test, grouped by event and source family; maintain an additional later temporal holdout. Store acquisition/as-of dates and prevent future evidence in historical-as-of evaluations. Public benchmarks can be contaminated by model training; supplement them with newly collected cases and document contamination risks.

Initial release corpus: at least 1,500 independently adjudicated claim instances from at least 300 stories, with 500 development, 500 calibration and 500 sealed test cases. These are minimums; increase held-out samples until the confidence bounds below are estimable. Include at least 50 held-out cases for each advertised major category; categories may overlap. No slice with insufficient evidence is advertised as validated. Include true/false/misleading/mixed/unknown cases, long articles, primary records, evolving events, historical claims, numerical/statistical errors, copied reporting, satire/quotation, entity collisions, malicious input, inaccessible pages, and images. Evaluate every advertised language separately; unsupported languages must receive an explicit status until validated.

Gold data requires two independent human annotations and adjudication of disagreements, with evidence spans, claim scopes, verdict, provenance expectations and ambiguity recorded. Agents may assemble candidate data and tooling; model-generated labels are not gold. Missing human annotations blocks release and calibration claims. Do not silently convert this dependency into another agent's opinion.

| Gate               | Definition and initial target                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim extraction   | Material-claim recall >= 0.95 and semantic precision >= 0.98 against adjudicated claim inventory; report atomicity separately                         |
| Citation integrity | 100% referenced IDs and offsets valid; zero fabricated quotations in held-out and adversarial runs                                                    |
| Evidence validity  | Human-audited citation entailment precision >= 0.98; report applicability/contradiction errors separately                                             |
| Retrieval          | Sufficient-evidence recall >= 0.90 on held-out answerable cases within the frozen profile; report inaccessible cases separately                       |
| Decisive verdicts  | One-sided 95% Wilson lower precision bound >= 0.95 separately for supported and contradicted; zero denominator fails                                  |
| Coverage           | At least 0.70 of held-out answerable factual claims receive a correct decisive verdict; abstaining on everything fails                                |
| Other verdicts     | Per-label precision/recall and confusion matrix; macro-F1 >= 0.85 across all five labels                                                              |
| Calibration        | ECE <= 0.05 using ten fixed equal-width bins, with bin counts; Brier score and risk-coverage curves also reported; no claims outside validated slices |
| Origin             | Candidate-selection precision >= 0.95 on cases with known admissible roots; coverage >= 0.70 on that subset; zero global-origin overclaims            |
| Robustness         | All required invariant fixtures pass; no cross-tenant disclosure or instruction execution from evidence                                               |
| Improvement        | Paired story-cluster bootstrap 95% lower bound for v2-minus-v1 joint evidence-and-verdict success > 0; no major slice degrades by more than 0.02      |

Compute Wilson with z=1.6448536269514722 for the specified one-sided bound. Use 10,000 story-cluster bootstrap resamples with a recorded seed. Report numerator, denominator, uncertainty, omissions, and retrieval outages for every metric. Joint success requires the correct label plus admissible, sufficient cited evidence; labels alone do not pass. Fixed-evidence runs isolate reasoning quality; replayed retrieval and live runs measure the full system separately. Comparisons require matched input/evidence availability and recorded budgets.

Model selection: compare configured latest stable candidates on development data, then fit a regularized logistic correctness calibrator using out-of-fold predictions within the calibration partition. Features include evidence applicability/directness, dependency-group counts, scope checks, challenge outcome and model self-score if available. Select the smallest threshold meeting the precision constraint with maximum coverage on calibration data; freeze all artifacts before testing. If performance/samples are inadequate, keep v2 in evaluation mode. Recalibrate after material model, prompt, extraction or retrieval changes. Never use test labels to tune thresholds.

Start with an evaluation-only resource profile: 120 external requests/run, 12 discovery queries/claim, 20 fetched candidates/claim, 3 provenance hops, 2 targeted retrieval rounds, 10-minute elapsed run cap, 3 concurrent external calls. All limits share the run budget; no per-stage multiplication bypass. These are configurable starting caps, not accuracy promises or production spend approval. Record actual tokens/cost when provider usage is available and “unknown” otherwise; enforce existing spend reservations. Exhaustion produces partial coverage. Task 12 determines and documents the accuracy/cost/latency frontier before recommending a production profile.

## Execution sequence

Run one task at a time by default. Give an agent the universal prompt and exactly one numbered task from `PROMPTS.md`. Do not launch downstream work before predecessor gates pass. A coordinator may schedule independent tasks only after contracts freeze and with disjoint file ownership; serial execution is the prescribed default.

| Task | Deliverable                                                          | Requires                                           |
| ---- | -------------------------------------------------------------------- | -------------------------------------------------- |
| 01   | Baseline, annotation policy, evaluation harness and dataset manifest | None                                               |
| 02   | Versioned contracts, pure stage interfaces and fixtures              | 01 harness/policy                                  |
| 03   | Durable run/snapshot storage and replay boundary                     | 02                                                 |
| 04   | Faithful text/link/image acquisition                                 | 03                                                 |
| 05   | Complete scoped claim inventory                                      | 04                                                 |
| 06   | Evidence discovery, acquisition and sufficiency controller           | 05                                                 |
| 07   | Excerpt entailment and dependency analysis                           | 06                                                 |
| 08   | Claim-level provenance and origin tracing                            | 07                                                 |
| 09   | Verdict adjudication and calibration integration                     | 08; fitting requires annotated calibration data    |
| 10   | Factual score and evidence-backed framing                            | 09                                                 |
| 11   | Single durable engine, API/UI integration and safe reuse             | 10                                                 |
| 12   | Sealed evaluation, operations rehearsal and cutover proposal         | 11; human gold, credentials and worker environment |
| 13   | Approved production cutover and legacy core retirement               | 12 passed; deployment authorization                |

Implement harnesses with small necessary invariant fixtures; the evaluation corpus measures the product, not line coverage. Keep the existing six cases as smoke tests. The code path can be built against clearly marked fixtures while human annotation proceeds; live release gates remain blocked until authentic evaluation data exists.

## Rollout and retirement

Use an explicit engine-version flag; legacy stored reports keep v1 rendering. Run v2 in offline/replay mode first, then opt-in shadow mode with spend/visibility controls. Shadow mode must not alter user-visible reports or domain reputation. Freeze a signed-off evaluation report identifying exact commit, configuration and dataset hashes.

Task 12 produces a concrete production proposal: worker hosting, environment changes, migration checks, backfill estimates, storage retention, cost limits, report-version compatibility, canary cohort and recovery procedure. Task 13 activates only after authorization. Canary at 5%, then 25%, then 100%, each for at least 24 hours and 100 completed runs with no critical invariant incidents; insufficient traffic extends the window. Hold expansion for error rate > 2%, budget overruns, unsupported citations or ownership leaks. Calibrated accuracy requires adjudicated samples; operational success alone is not accuracy validation.

After seven days at 100% with gates intact, remove legacy generation/retrieval/scoring entry points, duplicated orchestration and obsolete configuration. Preserve historical report decoding, evidence references and old calibration manifests. Do not delete user records or relabel legacy scores as v2. A failed canary reverts routing, not dependencies or schema versions. Use additive migrations and a forward-compatible recovery path.

## Research anchors

The design decisions above are Tracera-specific proposals. These primary sources motivate particular evaluation and interpretation choices, not the numeric targets:

- [AVeriTeC shared task](https://aclanthology.org/2024.fever-1.1/) evaluates real-world claim verification with evidence retrieval and verdict prediction. Use joint evidence/verdict evaluation rather than label accuracy alone.
- [AVeriTeC dataset and baseline](https://github.com/MichSchli/AVeriTeC) can supply an external evaluation adapter, subject to license, label mapping and temporal leakage review; it does not replace Tracera's own held-out cases.
- [On Calibration of Modern Neural Networks](https://proceedings.mlr.press/v70/guo17a.html) motivates empirical calibration of confidence. It does not establish calibration for this pipeline or justify trusting LLM self-ratings.
- [C2PA provenance specification](https://spec.c2pa.org/specifications/specifications/2.1/specs/C2PA_Specification.html) distinguishes validated provenance assertions from a consumer's interpretation. Valid content credentials do not themselves prove depicted events or claims true; missing credentials do not prove fabrication. Verify current specification and tooling when implementing.
