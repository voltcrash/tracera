# Tracera Core v2 Focused plan

Status: **authoritative active implementation plan**

Prepared: 2026-09-15

This plan defines the remaining implementation work for the focused Tracera product. It
supersedes the full-release program as the active product path. The older full-release plan,
evaluation report, release decision, operations runbook, production proposal, and task prompts
remain in the repository as historical context; they are not prerequisites for focused product
implementation.

Task 13 is documentation and policy only. It does not change the runtime, install a calibrator,
run a provider, alter a migration, delete a report, or authorize a deployment. Future tasks must
implement the focused boundary described here and add only the smallest additive contract/type
changes needed to represent it.

## Product promise and boundaries

Tracera Core v2 Focused is a small fact-checking flow for one submitted item at a time:

1. accept pasted text, a public article link, or an image/screenshot;
2. normalize the submitted item into complete, bounded, immutable snapshots when possible;
3. inventory every factual proposition that can be found within the supported input;
4. select at most three canonical claims that are both checkable and material;
5. retrieve and validate exact, applicable, independent evidence for those selected claims;
6. adjudicate each selected claim with explicit support, contradiction, conflict, or uncertainty;
7. show a factual score only when its evidence and coverage gates pass; and
8. show other Tracera features only when the underlying data for that feature exists and is
   separately supported.

The focused product is not a claim that every statement in an article was checked. The report
must show the selection scope, the number of inventoried claims, and claims that were not selected,
deferred, unavailable, or unresolved. A claim outside the selected set is not silently treated as
true, false, or unverified in the selected-claim score.

Focused policy identifiers should be versioned when implemented. The initial identifiers are:

- policy: `core-v2-focused-1.0.0`;
- score formula: `focused-supported-share-1.0.0`; and
- maximum selected claims: `3`.

These are product-policy identifiers, not evaluation results. The `0.80` resolution-coverage
floor below is a deterministic display rule, not a measured accuracy threshold. It must never be
described as statistical calibration or population-level validation.

### Active and historical documents

`FOCUSED-PLAN.md` is the active plan for future focused work. The following records are retained
but historical:

- [`PLAN.md`](PLAN.md) — the superseded full Core v2 rebuild and release program;
- [`EVALUATION-REPORT.md`](EVALUATION-REPORT.md) — Task 12's fixture-only full-release evaluation;
- [`RELEASE-DECISION.md`](RELEASE-DECISION.md) — the full-release decision and its blocked gates;
- [`OPERATIONS-RUNBOOK.md`](OPERATIONS-RUNBOOK.md) — full-release staging/worker/cutover procedures;
- [`PRODUCTION-CONFIGURATION-PROPOSAL.md`](PRODUCTION-CONFIGURATION-PROPOSAL.md) — an unapproved
  full-release deployment proposal; and
- [`PROMPTS.md`](PROMPTS.md) — prompts for the superseded 13-task full-release sequence.

The old release decision remains accurate for the program it evaluated: its full v2 release gates
did not pass. That fact is not a focused-product blocker. Focused implementation does not reopen,
complete, or reinterpret those gates, and it does not authorize production cutover.

## 1. Inputs and input identity

The public input contract accepts exactly one of these input families per run:

| Input               | Example                                                          | Required interpretation                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pasted text         | `{ "text": "..." }`                                              | The submitted text is the source document. Preserve its content and exact locators.                                                                                                 |
| Public link         | `{ "url": "https://example.test/article" }`                      | Fetch and extract the public document through the safe-fetch boundary. The URL alone is not article text or evidence.                                                               |
| Image or screenshot | `{ "image": "data:image/png;base64,..." }` or a public image URL | Retain the image bytes and, when available, produce OCR regions with page/frame boxes and uncertainty. Visual assertions require a real visual capability; OCR is not visual proof. |

Input parsing must reject multiple input kinds, malformed URLs, unsupported media, oversized
bodies, and invalid image encodings before analysis. Optional captions or source labels are
metadata only. They must have separate `user_caption`/metadata locators and must not be merged
into the submitted factual text.

The run context continues to carry tenant, owner, visibility, as-of time, engine/prompt/model and
retriever versions, budget, cancellation, and audit identity. Focused policy and selection version
must be added to the relevant focused artifact identity when the additive contract is implemented.

## 2. Full input normalization and immutable snapshots

Normalization is a complete stage before claim inventory. It must preserve what was submitted,
what was acquired, and what could not be acquired. It must never turn a hint into content.

### Acquisition and extraction

For pasted text:

- retain the submitted bytes/content hash and the exact bounded text used for offsets;
- apply only documented deterministic normalization, such as safe line-ending handling, while
  retaining a mapping or original representation whenever a transformation can affect location;
- record language, limits, extraction method, and any truncation or unsupported-language issue; and
- never silently take only the first three claims or first fixed character window.

For public links:

- permit only the existing safe HTTP(S) acquisition path and public-target policy;
- validate every redirect, DNS resolution, IP range, response size, MIME declaration, and body
  boundary, including cancellation during streaming;
- retain original, final, and validated canonical URLs separately;
- use structured HTML extraction for headings, paragraphs, lists, tables, quotations, captions,
  alt text, and numeric cells, with exact locators;
- retain a reader fallback only with its provider identity, limitations, and `partial` status;
- classify access-denied, CAPTCHA, anti-bot, short error, and blocked pages as unavailable/blocked;
  and
- keep URL slugs, link titles, provider snippets, and guessed headlines as discovery hints only.

For images and screenshots:

- validate image media type and file signature, retain the bounded raw bytes, and create an
  immutable raw snapshot when storage is available;
- run OCR only through an injected, explicitly identified capability;
- store OCR text in exact regions with half-open text offsets and page/frame bounding boxes;
- set `transcriptionUncertain` when the transcription is ambiguous or the capability reports an
  uncertainty that the contract can represent; a model confidence value is not a calibrated
  probability;
- keep visible OCR text, user captions, image metadata, content credentials, reverse-image
  results, and visual interpretations as different data types; and
- if no visual or provenance capability is configured, report that capability as unavailable and
  do not infer a person, place, date, event, authenticity, manipulation, or source history.

### Snapshot invariants

Every acquired document used downstream is an insert-only `DocumentSnapshot` with:

- a stable content-derived ID;
- SHA-256 hashes computed from actual retained raw bytes and normalized UTF-8 bytes, with an
  explicit unavailable blob state when raw storage is not available;
- immutable normalized text, MIME/language, acquisition time, original/final/canonical URLs,
  extraction method/status, byte/character limits, and truncation state;
- structural locators and timestamp assertions whose sources remain distinct;
- half-open UTF-16 code-unit spans into `normalizedText`, so `text.slice(start, end)` exactly
  reproduces every later quote; and
- OCR bounding boxes and page/frame identity where the locator came from an image.

No stage may mutate a completed snapshot or recompute a report from content that was not stored.
Raw and normalized hash mismatches are errors. Snapshot reads and writes must continue to enforce
tenant, owner, and visibility scope. A public source URL does not grant permission to share a
private submission or another owner's report.

### Explicit stage states

The normalized input stage must distinguish `complete`, `partial`, `unavailable`, `failed`, and
the separate canceled run state. Examples:

| Situation                                                                                                       | Required result                                                              |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Fully read supported text/article/image OCR                                                                     | Complete snapshot(s), exact locators, and `complete` status.                 |
| Truncation, reader fallback, uncertain/partial extraction, or one failed document in a multi-document operation | Retained partial snapshot/data, typed issue, and `partial` status.           |
| Blocked page, unavailable original, unsupported media/language, or unavailable OCR capability                   | Explicit unavailable status and reason; no fabricated document text.         |
| Provider or storage failure before a usable snapshot exists                                                     | Failed/unavailable status as appropriate; never a successful empty document. |
| Cancellation                                                                                                    | Canceled run with no scorecard manufactured from incomplete work.            |

Partial or unavailable input remains useful for showing what was observed, but it cannot silently
be promoted to a complete article or image fact-check.

## 3. Full claim inventory, then focused selection

### Complete inventory

The inventory stage runs over every substantive segment of every normalized submitted snapshot
within the supported limits. It is not capped at three. For each candidate proposition it records:

- exact submitted spans and later occurrences;
- a canonical subject/predicate/object proposition and qualifiers;
- attribution (`direct_assertion`, `attributed_statement`, or `quotation`);
- negation, quantities, units, denominators, time text/interval, place, and unresolved context;
- checkability, materiality, coverage disposition, parent relation, duplicate relation, and stable
  content-derived identity; and
- the segment's explicit disposition as a factual claim, opinion, background, non-checkable, or
  deferred, with a reason.

Claims are accepted only after exact quote/span and scope validation. Model output may suggest a
proposition but may not supply an unvalidated offset, claim ID, or invented quote. Attribution is
preserved: a claim that a ministry said something is not automatically the claim that the thing
said is true. Negation, numbers, units, denominators, names, pronouns, and explicit dates may not
be dropped during paraphrase. Unresolved referents remain `needs_context`.

Identical scoped propositions may merge into one canonical claim with occurrence spans. Copies in
other documents retain duplicate links and never receive extra score weight. Claims beyond any
analysis budget are retained as deferred inventory entries with a partial/deferred status. No
claim may disappear merely because it was not selected.

### Focused selection policy

After the full inventory, select zero to three claims using this exact eligibility filter:

```text
duplicateOfClaimId === null
&& coverageDisposition === "factual_claim"
&& checkability === "checkable"
&& material === true
```

Claims with `needs_context`, `unanswerable`, `not_checkable`, opinion/background disposition,
duplicates, and deferred processing are not selected as canonical focused claims. They remain
visible in the inventory with their reason. If a claim is uncertain because it intersects an
uncertain OCR region, it cannot be selected as checkable until that uncertainty is resolved.

“Top” is a deterministic, versioned product ordering, not a hidden model confidence ranking. The
ordering must be recorded with a reason and stable tie-breaker. The initial ordering should prefer,
in order, material claims with complete scope and checkability, then a transparent materiality or
centrality signal, then source order and content-derived claim ID. It must not prefer sensational
wording, loaded tone, provider reputation, or a model's self-reported confidence. A future task
may refine the ranking only by changing the focused policy version and preserving the old output.

The focused selection artifact must contain at least:

- the complete inventory count and inventory status;
- selected canonical claim IDs in rank order, never more than three;
- each selected claim's eligibility and selection reason;
- IDs and reasons for deferred, excluded, ambiguous, and not-selected claims; and
- the focused policy/selection version and the input snapshot hash.

The report must say “selected claims only” wherever it presents the score. It must not imply that
the remaining article was verified. Opinion-only input produces “No checkable factual claims,”
not a zero score.

## 4. Evidence retrieval, validation, independence, and provenance

Retrieval is performed only for the selected canonical claims. It can use the existing ports,
adapters, durable budget, and safe acquisition mechanisms, but it must not make the old release
program a prerequisite.

### Retrieval and acquisition

For each selected claim, plan neutral, supporting, disconfirming, primary-source, and applicable
time/jurisdiction/entity queries from the scoped proposition. Attributed statements may need both
an exact-statement query and a query for the underlying proposition. Numeric claims retain their
units and denominators. Unresolved context remains unresolved in the query; it is never filled by
guessing.

Keep discovery candidates separate from evidence snapshots:

- search results, snippets, provider ratings, URL slugs, and model knowledge are candidates or
  context only;
- a candidate becomes eligible for assessment only after the full relevant document is acquired,
  hash-checked, extracted, and linked to an immutable snapshot;
- passage selection and lexical ranking order work but do not establish entailment;
- the submitted input can establish what it says, but cannot independently corroborate its own
  underlying assertion; and
- an earlier Tracera verdict or corpus proposal is not evidence for a new claim.

Supporting and disconfirming work share one run budget. Quotas, spend reservations, time limits,
request caps, and cancellation remain authoritative. A successful empty search is distinct from a
provider outage, unavailable capability, timeout, budget exhaustion, or canceled run. Each query,
candidate rejection, fetch, snapshot, omission, outage, and stopping reason is auditable without
copying untrusted source text into logs.

### Citation and applicability validation

Every assessment used by a focused decision must pass all of these checks:

- the claim ID and immutable snapshot ID resolve inside the same scoped report;
- the quote equals the exact snapshot substring at its half-open UTF-16 offsets;
- the cited passage entails the complete scoped proposition or the explicitly incompatible
  proposition, rather than just sharing words;
- entity identity, attribution, negation, time, jurisdiction, units, denominator, calculation,
  and qualifiers match the claim's scope;
- the evidence is applicable in the relevant time and jurisdiction and its directness is recorded;
  and
- the assessment relation is explicit: `supports`, `contradicts`, `context`, `irrelevant`, or
  `insufficient`.

Invalid IDs, offsets, quotes, relation roles, scope, or calculations are retained as typed
validation failures and are not silently repaired or dropped. An invalid citation used by a
selected claim makes that claim unverified and blocks the aggregate score. A structurally invalid
report also fails closed. A rejected candidate that is not used by a selected decision may remain
outside the score, but its rejection and any effect on coverage must remain visible.

### Independence and provenance

Independence is based on underlying information origins, not domain or URL count. The evidence
layer must:

- group syndicated, copied, circularly cited, and same-publisher material with explicit
  dependency locators;
- treat unknown dependence as unknown, never as independent;
- distinguish a primary record from a secondary report and an attributed statement;
- require a usable applicable primary record or the focused policy's documented independent-origin
  rule before a one-sided decisive verdict; and
- preserve source applicability and source independence separately from any source reputation data.

Provenance is one claim-specific graph of actual document nodes and typed citation/attribution
edges. Archive captures and timestamps may establish an observed existence interval only when the
relevant claim appears in the captured content. Publication, update, event, index, archive, and
capture times remain distinct. Unknown dates, inaccessible originals, cycles, ties, and chronology
conflicts remain explicit. Use “earliest observed within the searched scope,” never “first on the
internet” or another global source-history claim.

New traversal documents must return through the same immutable snapshot and evidence-assessment
path before they can affect a decision. Provenance can explain where evidence came from; it does
not by itself establish that the claim is true.

## 5. Evidence-gated verdicts and focused score

### Claim-level verdicts without calibrated probabilities

The focused labels retain these meanings:

| Label          | Focused rule                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `supported`    | Valid, applicable evidence entails the complete scoped claim; citation integrity, independence, and any required challenge are resolved.     |
| `contradicted` | Valid, applicable evidence entails the incompatible scoped claim; citation integrity, independence, and any required challenge are resolved. |
| `misleading`   | Evidence shows a specific material distortion and cites both the submitted assertion and corrective context. Tone alone never qualifies.     |
| `mixed`        | Material applicable support and contradiction remain unresolved. Do not use it to hide an unresolved conflict or to force a vote.            |
| `unverified`   | Evidence, applicability, context, OCR, provenance, capability, or adjudication is insufficient. Preserve the typed reason.                   |

Adjudication may use a label-blind challenge and a bounded targeted retrieval/reassessment round
when the existing evidence path supports it. The challenger must receive the scoped claim and
validated evidence without the draft label, draft justification, or model self-confidence.
Disagreement, unresolved opposing evidence, unknown dependence, unavailable evidence, and failed
capabilities remain visible rather than being averaged into a confident label.

The focused product does not use statistical calibration. It must not fit, install, or imply a
calibrator; compare model candidates as a release claim; or emit a calibrated correctness
probability. A raw model confidence, if retained for internal diagnostics, is not a probability
of truth or label correctness and is never displayed, scored, or used as evidence.

The frozen full-release `Decision` schema currently makes decisive published labels depend on an
in-scope calibration artifact. Future focused implementation must therefore add an additive,
versioned focused decision/report boundary or projection. It must not put a fake calibrator into
the old field or silently change the meaning of saved full-release reports. A focused decision may
represent calibration explicitly as, for example:

```json
{
  "claimId": "claim_example",
  "label": "supported",
  "evidenceAssessmentIds": ["assessment_primary"],
  "challenge": { "status": "resolved", "agreed": true },
  "calibration": {
    "status": "not_used",
    "probability": null,
    "reason": "Focused policy is evidence-gated and does not use statistical calibration."
  }
}
```

This is a focused-contract example for future implementation, not evidence that a probability or
calibrator exists. Any compatibility projection into the existing report union must preserve
explicit null/unavailable state and the original v1 rendering behavior.

### Score definition

Let `Q` be the ordered set of selected canonical claims that have complete, eligible focused
claim records. Let:

- `supported` be the number of selected claims with an evidence-gated `supported` verdict;
- `contradicted` be the number of selected claims with an evidence-gated `contradicted` verdict;
- `resolved = supported + contradicted`; and
- `resolutionCoverage = resolved / |Q|` when `|Q| > 0`.

The only focused factual score is:

```text
100 * supported / (supported + contradicted)
```

It uses equal weight per resolved selected claim. `mixed`, `misleading`, `unverified`, deferred,
not-selected, duplicate, opinion, and non-checkable claims never become fractional truth values.
They remain separate counts and reasons. The UI must show the resolved numerator/denominator,
selected-claim count, resolution coverage, input/extraction status, and formula version beside the
value. Use the label “Supported share of resolved claims” with a clear “selected claims only” scope
note; never call it accuracy, credibility, probability of truth, or a universal article score.

Illustrative arithmetic only: two supported and one contradicted selected claims produce
`100 * 2 / (2 + 1) = 66.666...`. This example is not a measurement.

### Exact null-score rules

The focused score is `null` whenever any applicable condition below holds. The report keeps the
claim-level evidence and typed state; null is not zero.

| Condition                                                                                                                                            | Required score behavior                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No selected checkable material claims                                                                                                                | Null with `no_checkable_claims` (or the additive focused equivalent) and the user-facing message “No checkable factual claims.”                                                                  |
| Zero resolved selected claims                                                                                                                        | Null with `zero_resolved_denominator`; never divide by zero and never map unknown to 0 or 50.                                                                                                    |
| Resolution coverage below `0.80`                                                                                                                     | Null with `resolution_coverage_below_threshold`/`insufficient_coverage`. At three selected claims, resolving only two is `2/3` and therefore insufficient.                                       |
| Partial input, incomplete inventory, truncation that could hide a selected/top claim, or partial extraction                                          | Null with `partial_input` and/or `partial_extraction`. The report must expose what was incomplete.                                                                                               |
| Invalid citation, offset, quote, scope, or report reference used by a selected decision                                                              | Null with `citation_validation_failed` or the focused equivalent; preserve the rejected assessment/issue.                                                                                        |
| Unresolved support/contradiction, unresolved challenge, material `mixed`, or unresolved chronology/applicability conflict affecting a selected claim | Null with `unresolved_conflict`/`material_mixed_or_misleading_open`; preserve both sides and the conflict.                                                                                       |
| A material selected `misleading` result                                                                                                              | It is shown at claim level but is not a supported/contradicted resolution. The initial focused policy treats it as score-blocking rather than presenting a high share from the remaining claims. |
| Provider outage, unavailable source/OCR capability, budget exhaustion, or cancellation leaves a selected claim unresolved                            | Keep the exact unavailable/partial/canceled state; the resulting zero/low coverage or run state makes the score null. No outage is a successful no-results result.                               |
| Run failed or canceled                                                                                                                               | Null/no scorecard, with the run terminal state and reasons preserved.                                                                                                                            |

An uncertain OCR region does not become a checkable claim. If it intersects a selected claim or
causes inventory completeness to be unknown, the claim is unverified and the score is null. If it
is outside the selected claims and the inventory is complete, the uncertainty is still displayed;
it does not silently become evidence or a confidence value.

The score may be non-null only when the selected set is nonempty, the submitted input and full
inventory are complete, every scored citation is valid and applicable, all score-blocking conflicts
are resolved, at least one selected claim resolves, and `resolutionCoverage >= 0.80`. A null score
always carries the exact reasons that caused the gate.

## 6. Separate semantics for adjacent features

Focused reporting must not collapse distinct concepts into one score or one trust signal.

| Feature           | It may show                                                                                                                                                                              | It must not do                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framing           | Exact submitted-text observations such as emotional language, attributed quotation, or negative reporting; evidence-backed context omission/skew only with validated corrective context. | Convert tone, sentiment, attribution, or subject matter into truth penalties; cite evidence for a text-only observation; change the factual score.                                       |
| Source reputation | Publisher/source metadata or a reputation record only when a real, scoped, versioned data source supplied it, with unknown/unavailable shown explicitly.                                 | Infer trust from domain count, branding, URL rank, prior Tracera verdicts, or a model's opinion; auto-update domain trust from the current result; alter claim score.                    |
| Provenance        | Claim-specific citation graph, source/dependency edges, actual archive observations, candidate roots, and searched-scope uncertainty.                                                    | Claim a global first source, fabricate history, turn earliest-observed status into truth, or use provenance absence as proof of falsity.                                                 |
| Image OCR         | Immutable image/raw snapshot identity, OCR text, exact regions, page/frame boxes, extraction method, and explicit uncertainty.                                                           | Treat OCR as visual authentication; invent people, places, dates, events, captions, reverse-image results, credentials, or calibrated OCR confidence.                                    |
| Timelines         | Separate published/updated/event/indexed/archived/captured assertions, as-of time, precision, timezone, and applicability.                                                               | Penalize old evidence merely for age, merge event time with publication time, guess missing dates, or declare a global earliest event/source.                                            |
| Reuse             | Exact owner/tenant/visibility-scoped reuse when input bytes/content hash, canonical proposition scope, focused policy, engine/configuration, evidence identity, and freshness all match. | Reuse by URL alone, lexical/embedding similarity, related story, similar image, changed OCR, changed evidence, or an incompatible version; turn a cached unknown into a verified result. |
| Related context   | Clearly labeled, permission-scoped related stories, copies, corpus candidates, image context, or explanatory links when those records were actually acquired and available.              | Treat context as corroboration, include it in the selected-claim denominator, hide it as evidence, or present a missing capability as a completed search.                                |

Each adjacent feature has its own status and provenance. If its source or capability is absent, the
report says unavailable or unknown. No feature is displayed as a fact merely because a related
feature has data.

## 7. Retained safety, access, and operational controls

Focused implementation retains the correctness and safety properties already built:

- immutable input/evidence snapshots, actual-byte hashes, exact quotes, and half-open offsets;
- applicability checks for entities, attribution, negation, quantities, denominators, time,
  jurisdiction, and calculations;
- source-independence and dependency grouping based on underlying origins;
- safe-fetch, redirect, DNS/IP, MIME, size, body-stream, and SSRF protections;
- structured untrusted-data prompts and strict model-output validation, so source text cannot issue
  instructions, change schemas, or invoke tools;
- authentication, owner/tenant isolation, visibility predicates, publication-consent boundaries,
  and owner-scoped report/evidence routes;
- idempotency, request/concurrency/daily quotas, spend reservations, deadlines, and cancellation;
- explicit `complete`, `partial`, `unavailable`, `failed`, and `canceled` distinctions with typed
  issues and audit events; and
- strict Core v2 report decoding and rendering.

The active focused path must not depend on a human-gold release bundle or on a statistical
calibrator. This does not permit weaker runtime safety, lower validation standards, fabricated
provider data, or unbounded work. Existing durable/admission controls may be reused; no new host,
worker, staging, or cutover project is required by this plan.

## 8. Focused API and report behavior

The future focused implementation should keep the versioned HTTP boundary and existing admission
controls. A request still represents one of the three input families, for example:

```json
{ "text": "The ministry said unemployment fell to 4.1% in 2025." }
```

```json
{ "url": "https://example.test/public-article" }
```

```json
{ "image": "data:image/png;base64,...", "imageMimeType": "image/png" }
```

The durable response remains an identity/progress response rather than a detached request promise.
The completed report must expose, at minimum, the focused policy/version, input snapshot status,
full inventory summary, selected claim IDs/ranks, excluded/deferred reasons, claim decisions,
validated evidence excerpts, dependency/provenance state, separate adjacent-feature states, the
score or null, exact null reasons, and cost/request/cancellation state.

A conceptual focused score block is:

```json
{
  "scope": "selected_claims_only",
  "selectedClaims": 3,
  "resolved": { "supported": 2, "contradicted": 1 },
  "factualScore": 66.66666666666667,
  "formulaVersion": "focused-supported-share-1.0.0",
  "resolutionCoverage": 1,
  "nullReasons": [],
  "calibratedProbability": null
}
```

The arithmetic is illustrative only. `calibratedProbability` is always null in focused output;
the field is shown only to make the non-calibration boundary explicit. A final contract may use a
different field name, but it must not emit a number or imply that the example is a measurement.

## 9. Exact focused out-of-scope list

The following are deliberately not part of Core v2 Focused and must not become hidden
prerequisites, claims, or release language:

- a 1,500-claim/300-story human-gold collection program, two-annotator research corpus, or
  population-level accuracy estimate;
- statistical calibration, calibrated correctness probabilities, confidence intervals, ECE,
  Brier/risk-coverage claims, Wilson/bootstrap release metrics, or model-comparison claims;
- a sealed-test partition, sealed-test opening, test-tuning rule, or full-release gate ledger;
- live paid v1/v2 matched evaluation, provider capability/cost/latency measurements, or any
  fabricated provider/model result;
- staging environments, canary percentages, rollback routing, cutover approval, or a new
  production worker-host/scheduling project;
- a separate production deployment project, production migration, production shadow traffic, or
  deployment evidence; the existing app/runtime remains the delivery boundary when authorized by
  the normal project workflow;
- a global “first source,” universal source history, or provenance claim without acquired,
  applicable, claim-bearing records;
- automatic domain-reputation refinement from verdicts, an omnibus credibility/style average, or
  source reputation as a truth prior;
- visual-authenticity, deepfake, identity, location, event, or reverse-image claims without a
  real capability and exact supporting data;
- semantic/embedding reuse of changed content, similar images, related stories, syndicated copies,
  or prior model outputs as if they were identical evidence; and
- a score for the whole article, all inventoried claims, opinions, or unselected claims.

The product may record unknown, unavailable, or not-evaluated states for any out-of-scope feature,
but it must not fill them with a placeholder value or describe fixture behavior as real-world
evidence.

## 10. Remaining implementation sequence

Future focused tasks should proceed in this order, with each task preserving the existing safety
ports and saved-report compatibility:

1. Add the focused policy/version and the smallest additive selection/report types. Do not change
   the frozen full-release contract in place and do not add a calibrator requirement.
2. Run existing normalization and full claim inventory, then implement the deterministic top-three
   selection artifact and explicit not-selected/deferred/uncertain states.
3. Route only selected canonical claims through retrieval, exact citation validation, independence,
   provenance, and label-blind adjudication. Keep source applicability and conflicts visible.
4. Add focused evidence-gated publication and the pure selected-claim score/null policy. Remove the
   old calibration stage from this product path by using the focused boundary, not by manufacturing
   a calibration artifact or weakening the old path.
5. Project the focused report in the existing authenticated UI/API, with selected scope, exact
   excerpts, statuses, adjacent-feature boundaries, and v1 rendering compatibility.
6. Add a small deterministic fixture/regression suite, then run repository checks. Fixtures are
   engineering guardrails only; they are not human labels, provider measurements, calibration, or
   proof of population-level accuracy.

No step above requires a separate deployment project, staging/canary plan, worker-host selection,
sealed evaluation, or full-release approval bundle. Those historical artifacts must remain
unchanged except for their historical-context notices.

## 11. Focused fixture and regression guardrail

The focused suite should be small and deterministic, with no network, credentials, paid provider,
human-gold labels, or statistical claims. It should cover at least:

- pasted text with four or more factual propositions, proving that the full inventory is retained
  while no more than three eligible claims are selected;
- opinion-only and no-checkable input, with an explicit no-claim state rather than zero score;
- public-link structured extraction, blocked/slug-only pages, safe-fetch redirect rejection, and
  partial/unavailable extraction;
- a clear screenshot with exact OCR regions and a screenshot with uncertain OCR that stays
  unresolved/unverified;
- invalid IDs, invented quotes, shifted offsets, wrong entity/year/jurisdiction, altered units or
  denominators, and failed calculation checks;
- strong support, strong contradiction, copied/syndicated evidence grouped to one origin,
  unavailable source, no-results, provider outage, budget exhaustion, and unresolved conflict;
- formula arithmetic and every null-score condition, including `2/3` resolution coverage failing
  the `0.80` floor;
- framing observations, source metadata, provenance candidates, timelines, reuse, and related
  context remaining separate and unable to change the factual score;
- prompt-injection, SSRF, authentication, owner/tenant/visibility, idempotency, quota, spend,
  cancellation, and v1-rendering regressions.

Each fixture result must identify whether it is a deterministic invariant check, an unavailable
capability, or an unknown result. The suite must not report precision, recall, calibration,
provider quality, or universal accuracy from fixture counts.
