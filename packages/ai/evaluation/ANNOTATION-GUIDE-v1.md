# Tracera core evaluation annotation guide

Version: 1.0.0

Frozen: 2026-09-10

Applies to: core-overhaul evaluation datasets with schema version 1.0.0

## Unit of annotation

Annotate atomic, scoped factual propositions, not sentences or stories. Preserve the exact submitted wording and one or more half-open JavaScript UTF-16 spans. Split conjunctions when either proposition could receive a different label. Retain attribution, negation, quantities, units, denominator, place, jurisdiction, and applicable time.

Before extraction recall is measured, two annotators independently inventory every material factual proposition in the complete document. They also mark substantive segments as opinion, background, non-checkable, or deferred. An adjudicator resolves inventory differences and freezes the gold inventory. Extractor output never grades itself; approximate automatic matches remain `human_review_required`.

## Materiality

A proposition is material when changing or removing it would reasonably change the article's central factual impression, a headline/subheading assertion, a stated causal or numerical conclusion, or the reader's understanding of a person or institution's conduct. Incidental dates, navigation, bylines, and decorative detail are not material unless the story relies on them. Record close calls and the adjudicator's resolution.

## Evidence and labels

Only acquired evidence documents with mechanically valid excerpts are admissible. Search snippets, URLs, model knowledge, and previous Tracera outputs can guide discovery but cannot decide a label. The submission establishes what it says, not the truth of its underlying assertion. Count information origins rather than domains.

- `supported`: admissible evidence entails the full scoped proposition and its challenge is resolved.
- `contradicted`: admissible evidence entails an incompatible proposition with matching scope and its challenge is resolved.
- `misleading`: cited evidence establishes both the stated assertion and a specific omitted or distorted context that materially changes its interpretation. Tone alone is insufficient.
- `mixed`: material, applicable support and contradiction remain unresolved. Do not use this to avoid splitting a compound claim.
- `unverified`: evidence or interpretation is insufficient. Record the reason, such as inaccessible evidence, unanswerable scope, ambiguous entity, or missing calibration.

Confidence is the probability that the emitted label is correct under this guide, not the probability that the proposition is true. Annotators do not infer calibrated confidence.

## Required examples

Attribution: “The agency said the bridge opened in 2025” is a claim about whether the agency made that statement. It is not automatically a claim that the bridge opened in 2025. Annotate the underlying assertion separately only when the input asserts it.

Time change: “The unemployment rate is 5%” can be supported for one release date and contradicted for another. Match event time, publication/update time, jurisdiction, and denominator; later evidence is forbidden in a historical as-of run.

Misleading context: a chart accurately shows growth from 2020–2024 but selects 2020 after a larger decline. Use `misleading` only if cited excerpts establish the shown interval and the omitted comparison and the omission changes the material interpretation.

Conflicting evidence: two applicable primary records give incompatible totals and neither conflict can be resolved after the prescribed challenge/retrieval step. Use `mixed`, preserve both excerpts, and record dependence and scope checks.

Unanswerable claim: “This is the first private collection ever assembled” has no complete registry or justified closed-world source. Use `unverified`; absence of search results is neither contradiction nor proof of uniqueness.

Origin uncertainty: if the earliest retrieved report cites an inaccessible source, record both as candidates and mark origin uncertain. Never label a global “first source.” Origin uncertainty does not lower the truth label by itself.

## Annotation and adjudication procedure

1. Freeze document bytes/text, content hash, language, acquisition time, as-of time, split, event group, and source-family group.
2. Two annotators independently inventory claims, spans, materiality, checkability, labels, evidence excerpts, dependence groups, and origin expectations.
3. Validate quote identity and offsets mechanically. Evidence acquired after the as-of time is excluded and recorded as temporal leakage.
4. Adjudicate every disagreement without showing either annotator model output. Record the adjudicator, time, resolution, and ambiguity.
5. Mark a claim `adjudicated_human` only after both annotations and adjudication exist. Synthetic, candidate, and model-generated labels are never gold.
6. Freeze development, calibration, sealed-test, and later temporal partitions by event and source family before model comparison. Never tune on sealed-test labels.

Licensing must identify the source terms, redistribution permission, and whether only locators/derived annotations may be stored. Do not import external content until its license and label mapping are reviewed.
