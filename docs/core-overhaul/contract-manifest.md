# Tracera core v2 contract manifest

Status: frozen by task 02 on 2026-09-10. Downstream tasks import these schemas and
types and may not define parallel models. Changing a frozen schema requires an
explicit contract revision and a recalibration review, not an in-place edit.

| Identifier                              | Value                             |
| --------------------------------------- | --------------------------------- |
| `CORE_V2_SCHEMA_VERSION`                | `2`                               |
| `CORE_V2_CONTRACT_VERSION`              | `"2.0.0"`                         |
| `CORE_V2_SCORE_FORMULA_VERSION`         | `"factual-supported-share-1.0.0"` |
| `CORE_V2_RESOLUTION_COVERAGE_THRESHOLD` | `0.8`                             |
| `CORE_V2_ENGINE_VERSION`                | `"core-v2.0.0"`                   |

Import sites:

```ts
import { runReportSchema, type RunReport } from "@repo/contracts/core-v2";
import type { RunEnvironment, RunAnalysisV2 } from "@repo/ai/src/core/types";
```

Runtime schemas and inferred types live in `packages/contracts/src/core-v2.ts`,
exported through the `@repo/contracts/core-v2` subpath. Ports and stage
signatures live in `packages/ai/src/core/types.ts`. Legacy v1 contracts in
`packages/contracts/src/index.ts` are untouched and remain operational; the
default `@repo/contracts` entry point is unchanged, so existing consumers
type-check exactly as before.

## Schema inventory

| Schema                      | Type                  | Purpose                                                                          |
| --------------------------- | --------------------- | -------------------------------------------------------------------------------- |
| `spanSchema`                | `Span`                | Half-open UTF-16 code-unit range into a snapshot's `normalizedText`              |
| `boundingBoxSchema`         | —                     | OCR region with page and optional frame identity                                 |
| `timeIntervalSchema`        | `TimeInterval`        | Typed time with precision and timezone; unknown is `{earliest:null,latest:null}` |
| `issueSchema`               | `CoreIssue`           | Typed stage issue with a code from `issueCodeSchema`                             |
| `stageMetricsSchema`        | `StageMetrics`        | Per-stage timing, external requests, tokens and cost, each nullable              |
| `stageResultSchema(data)`   | `StageResult<T>`      | `{status, data, issues, metrics}` factory for every stage                        |
| `runContextSchema`          | `RunContext`          | Serializable run identity, versions, budget and cancellation state               |
| `runBudgetSchema`           | `RunBudget`           | Shared run caps; no per-stage multiplication                                     |
| `engineVersionsSchema`      | `EngineVersions`      | Engine, prompt, model, retriever, embedding and calibration identities           |
| `documentSnapshotSchema`    | `DocumentSnapshot`    | Immutable normalized document with hashes, locators and timestamp assertions     |
| `locatorSchema`             | `Locator`             | Structural locator, optional bounding box, uncertain-transcription flag          |
| `timestampAssertionSchema`  | `TimestampAssertion`  | Typed publication/update/event/index/archive/capture time plus its source        |
| `discoveryHintSchema`       | `DiscoveryHint`       | Slug, link title, snippet or caption: never a factual claim                      |
| `claimSchema`               | `ClaimV2`             | Scoped proposition with spans, attribution, negation, quantities and time        |
| `inputCoverageSchema`       | `InputCoverage`       | Segment-level disposition of the whole document                                  |
| `evidenceCandidateSchema`   | `EvidenceCandidate`   | Discovery record with `admissible: false` as a structural literal                |
| `evidenceAssessmentSchema`  | `EvidenceAssessment`  | Claim/excerpt relation, applicability, directness, dependence and checks         |
| `sufficiencyFeedbackSchema` | `SufficiencyFeedback` | Feedback from assessment into targeted retrieval rounds                          |
| `provenanceGraphSchema`     | `ProvenanceGraph`     | Per-claim graph, candidate roots, search log and unresolved chronology           |
| `calibrationSchema`         | `Calibration`         | Discriminated on `applicability`; only `in_scope` carries a probability          |
| `challengeSchema`           | `Challenge`           | Independent reassessment outcome                                                 |
| `decisionSchema`            | `Decision`            | Diagnostic and published labels, reason codes and cited assessments              |
| `presentationFindingSchema` | `PresentationFinding` | Language observation or evidence-backed material context finding                 |
| `scorecardSchema`           | `Scorecard`           | Nullable factual score, counts, coverage and separate evidence/origin fields     |
| `stageOutcomeSchema`        | `StageOutcome`        | Per-stage status recorded on the report                                          |
| `replayManifestSchema`      | `ReplayManifest`      | Everything needed to recompute deterministic decisions                           |
| `runReportSchema`           | `RunReport`           | Versioned public report, schema version 2                                        |
| `legacyRunReportSchema`     | `LegacyRunReport`     | Saved v1 reports, schema version 1, decoded and rendered unchanged               |
| `versionedRunReportSchema`  | `VersionedRunReport`  | Discriminated union on `schemaVersion`                                           |

## Frozen enumerations

- **Stage status** — `complete`, `partial`, `unavailable`, `failed`.
- **Run status** — the four stage statuses plus `canceled` as a separate terminal state.
- **Stages** — `normalize_input`, `extract_claims`, `retrieve_evidence`, `assess_evidence`,
  `trace_origins`, `adjudicate_claims`, `calibrate_decisions`, `score_report`.
- **Claim labels** — `supported`, `contradicted`, `misleading`, `mixed`, `unverified`.
  `decisiveLabels` is `supported`, `contradicted`, `misleading`.
- **Issue codes** — `missing_evidence`, `provider_failure`, `provider_outage`, `rate_limited`,
  `timeout`, `capability_unavailable`, `content_unavailable`, `blocked_page`,
  `unsupported_format`, `unsupported_language`, `ambiguous_input`, `truncation`,
  `budget_exhausted`, `cancellation_requested`, `snapshot_unavailable`,
  `citation_validation_failed`, `calibration_unavailable`, `dependency_unknown`,
  `human_review_required`, `deferred_processing`.
- **Decision reason codes** — `supported_by_admissible_evidence`,
  `contradicted_by_admissible_evidence`, `material_distortion_with_corrective_context`,
  `unresolved_material_conflict`, `no_admissible_evidence`, `evidence_not_applicable_in_time`,
  `evidence_not_applicable_to_entity`, `evidence_not_applicable_in_jurisdiction`,
  `insufficient_independent_origins`, `citation_validation_failed`, `ambiguous_claim_scope`,
  `unresolved_context`, `unresolved_challenge_disagreement`, `calibration_unavailable`,
  `calibration_out_of_scope`, `budget_exhausted_before_resolution`, `source_unavailable`,
  `unsupported_language`, `awaiting_deferred_processing`, `no_checkable_proposition`.
- **Score null reasons** — `zero_resolved_denominator`, `no_checkable_claims`, `partial_input`,
  `partial_extraction`, `resolution_coverage_below_threshold`,
  `material_mixed_or_misleading_open`, `run_canceled`, `run_failed`.

## Invariants the schemas enforce at runtime

Citation and offset integrity:

1. Every `EvidenceAssessment.excerpt` must satisfy
   `snapshot.normalizedText.slice(span.start, span.end) === quote`. Invented quotes and
   shifted offsets are rejected, not silently dropped.
2. The same offset identity is enforced on assessment dependence locators and on
   provenance edge supporting locators.
3. Every assessment, candidate, provenance graph, coverage segment and decision must
   reference a claim and snapshot present in the same report. Replay manifest snapshot
   and assessment IDs must resolve too.
4. A decision may cite only assessments belonging to its own claim, and only assessments
   whose `validationStatus` is `validated`.
5. An assessment with any failed check cannot be `validated`. A stated dependence
   relation other than `independent` or `unknown` must carry supporting locators.
6. Claim spans may not exceed the snapshot text length. Claim `text` is deliberately not
   required to equal the raw span text: splitting conjunctions and preserving qualifiers
   changes the wording. Exact span fidelity against the source sentence is task 05's
   extraction obligation, checked by the evaluation harness.

Decision publishability:

7. `diagnosticLabel` is the adjudicated label used for evaluation and calibration.
   `publishedLabel` is what users see. A decisive `publishedLabel` requires
   `calibration.applicability === "in_scope"`, `challenge.status === "resolved"` and
   `citationIntegrity === "valid"`. Otherwise the published label must be `unverified`.
8. `supported` requires supporting assessment IDs, `contradicted` requires contradicting
   IDs, `misleading` requires both the stated assertion and corrective-context IDs, and
   `mixed` requires supporting and contradicting IDs.
9. `rawModelConfidence` is diagnostic only. Only the `in_scope` calibration branch may
   carry `calibratedCorrectness`; every other branch is structurally `null`.

Score consistency:

10. Verdict counts must sum to `eligibleFactualClaims`, and `resolutionCoverage` must
    equal `(supported + contradicted) / eligibleFactualClaims`, or `null` when the
    denominator is zero.
11. `factualScore` is non-null exactly when `nullReasons` is empty, and must then equal
    `100 * supported / (supported + contradicted)`.
12. Zero eligible claims, zero resolved claims, partial input, partial extraction,
    coverage below `0.8`, and an open material mixed/misleading claim each force their
    null reason. A gated scorecard must report a null score.
13. Scorecard counts must match the tally of `publishedLabel` across decisions.
14. A `canceled` run cannot carry a scorecard. A `complete` run requires every stage
    outcome to be `complete`.

Stage results:

15. `complete` and `partial` stage results carry data; `unavailable` and `failed` never do.
    Any non-complete stage must state at least one typed issue, so a failed retrieval
    cannot present itself as a completed empty search.

There is no `z.any`, `z.unknown` or open record anywhere in the core evidence objects.
Every core entity is a `strictObject`, so unknown keys are rejected. The only loose
schema in the file is `legacyRunReportSchema`, which exists solely to keep saved v1
reports decodable.

## Ports

Core stage logic depends only on `@repo/contracts/core-v2` and on `RunEnvironment`. It
must not import database globals, read `process.env` or call `fetch`. A fixture run
therefore needs no network, provider credentials or production database.

```ts
interface CorePorts {
  generation: GenerationPort; // structured model output, untrusted content kept as data
  embeddings: EmbeddingPort; // modelId, dimensions, preprocessing are part of identity
  search: SearchPort[]; // candidate generators; each returns a StageResult
  documents: DocumentAcquisitionPort; // acquire(url) / acquireFromText -> immutable snapshot
  snapshots: SnapshotStorePort; // put / get / getMany
  runs: RunStorePort; // checkpoint, readCheckpoint, finalize with fencing token
  clock: ClockPort; // now(): ISO-8601 with offset, monotonicMs()
  audit: AuditPort; // typed AuditEvent sink
}

interface RunEnvironment {
  context: RunContext;
  ports: CorePorts;
  signal: AbortSignal;
}
```

`RunContext` is the serializable half of run identity. The audit sink is referenced from
it by `auditSinkId`; the live sink, the ports and the `AbortSignal` travel on
`RunEnvironment` and are never persisted inside a report.

## Stage signatures

```ts
type NormalizeInputV2 = (
  i: NormalizeInputV2Input,
  env: RunEnvironment,
) => Promise<StageResult<NormalizeInputV2Data>>;
type ExtractClaimsV2 = (
  i: ExtractClaimsV2Input,
  env: RunEnvironment,
) => Promise<StageResult<ExtractClaimsV2Data>>;
type RetrieveEvidenceV2 = (
  i: RetrieveEvidenceV2Input,
  env: RunEnvironment,
) => Promise<StageResult<RetrieveEvidenceV2Data>>;
type AssessEvidenceV2 = (
  i: AssessEvidenceV2Input,
  env: RunEnvironment,
) => Promise<StageResult<AssessEvidenceV2Data>>;
type TraceOriginsV2 = (
  i: TraceOriginsV2Input,
  env: RunEnvironment,
) => Promise<StageResult<TraceOriginsV2Data>>;
type AdjudicateClaimsV2 = (
  i: AdjudicateClaimsV2Input,
  env: RunEnvironment,
) => Promise<StageResult<AdjudicateClaimsV2Data>>;
type CalibrateDecisionsV2 = (
  i: CalibrateDecisionsV2Input,
  env: RunEnvironment,
) => Promise<StageResult<CalibrateDecisionsV2Data>>;
type ScoreReportV2 = (i: ScoreReportV2Input) => StageResult<ScoreReportV2Data>;
type RunAnalysisV2 = (i: RunAnalysisV2Input, env: RunEnvironment) => Promise<RunAnalysisV2Result>;
```

`scoreReportV2` is the one synchronous pure stage: it takes no ports, makes no model
calls and receives the orchestrator's clock reading as `input.at`, so scoring is
replayable from persisted artifacts. `retrieveEvidenceV2` takes `round` and the
`SufficiencyFeedback` produced by `assessEvidenceV2`, which is how at most two targeted
rounds are expressed. `traceOriginsV2` returns `newSnapshotIds`, which the orchestrator
must feed back through assessment before adjudication.

## Canonical examples

The authoritative examples are the exported constants `coreV2Examples` and
`runContextExample` in `packages/contracts/src/core-v2.ts`, covering `complete`,
`partial`, `unavailable`, `ambiguous`, `canceled`, `noClaim` and `legacy`. A test parses
every one of them through `versionedRunReportSchema`. They illustrate contract shape
only: no calibrator has been fitted and no evaluation has been run, so
`example-calibrator-0` is a placeholder demonstrating the `in_scope` branch, not
evidence that a calibrator exists.

The `complete` example in full:

```json
{
  "schemaVersion": 2,
  "contractVersion": "2.0.0",
  "runId": "run_example_complete",
  "createdAt": "2026-09-10T00:00:00.000Z",
  "asOfTime": "2026-09-10T00:00:00.000Z",
  "engineVersion": "core-v2.0.0",
  "visibility": "private",
  "status": "complete",
  "stageOutcomes": [
    {
      "stage": "normalize_input",
      "status": "complete",
      "issues": [],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    },
    {
      "stage": "extract_claims",
      "status": "complete",
      "issues": [],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    },
    {
      "stage": "retrieve_evidence",
      "status": "complete",
      "issues": [],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    },
    {
      "stage": "assess_evidence",
      "status": "complete",
      "issues": [],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    },
    {
      "stage": "trace_origins",
      "status": "complete",
      "issues": [],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    },
    {
      "stage": "adjudicate_claims",
      "status": "complete",
      "issues": [],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    },
    {
      "stage": "calibrate_decisions",
      "status": "complete",
      "issues": [],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    },
    {
      "stage": "score_report",
      "status": "complete",
      "issues": [],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    }
  ],
  "snapshots": [
    {
      "contentHash": "sha256:f3878f1a6066eacd7439ee4c8932d6652888776559768b8c91c9c4724d947083",
      "rawContentHash": null,
      "originalUrl": null,
      "finalUrl": null,
      "canonicalUrl": null,
      "acquiredAt": "2026-09-10T00:00:00.000Z",
      "mimeType": "text/plain",
      "language": "en",
      "role": "submitted_input",
      "extractionStatus": "complete",
      "extractionMethod": "plain_text",
      "limits": {
        "byteLimit": 5000000,
        "characterLimit": 200000,
        "bytesRetained": 44,
        "charactersRetained": 44,
        "truncated": false
      },
      "locators": [
        {
          "id": "loc_input_p1",
          "kind": "paragraph",
          "path": "/article/p[1]",
          "span": {
            "start": 0,
            "end": 44
          },
          "boundingBox": null,
          "transcriptionUncertain": false
        }
      ],
      "timestampAssertions": [],
      "discoveryHints": [],
      "blobLocator": {
        "status": "unavailable",
        "uri": null
      },
      "id": "snap_input_complete",
      "normalizedText": "Aurora Labs opened a plant in Turin in 2024."
    },
    {
      "contentHash": "sha256:7f9a9cdaa4a1430815186c27c928283ffa51a12b280818e692175e3d7ca50b2e",
      "rawContentHash": null,
      "originalUrl": "https://records.example.org/turin-plant",
      "finalUrl": "https://records.example.org/turin-plant",
      "canonicalUrl": "https://records.example.org/turin-plant",
      "acquiredAt": "2026-09-10T00:00:00.000Z",
      "mimeType": "text/html",
      "language": "en",
      "role": "evidence",
      "extractionStatus": "complete",
      "extractionMethod": "structured_html",
      "limits": {
        "byteLimit": 5000000,
        "characterLimit": 200000,
        "bytesRetained": 56,
        "charactersRetained": 56,
        "truncated": false
      },
      "locators": [],
      "timestampAssertions": [
        {
          "type": "published",
          "interval": {
            "earliest": "2024-06-01T00:00:00.000Z",
            "latest": "2024-06-01T00:00:00.000Z",
            "precision": "day",
            "timezone": "UTC"
          },
          "source": "structured_data",
          "locatorId": null
        }
      ],
      "discoveryHints": [],
      "blobLocator": {
        "status": "stored",
        "uri": "snapshot://snap_evidence_complete"
      },
      "id": "snap_evidence_complete",
      "normalizedText": "The Turin plant of Aurora Labs began operations in 2024."
    }
  ],
  "primarySnapshotId": "snap_input_complete",
  "claims": [
    {
      "id": "claim_complete_1",
      "documentId": "snap_input_complete",
      "text": "Aurora Labs opened a plant in Turin in 2024.",
      "spans": [
        {
          "start": 0,
          "end": 44
        }
      ],
      "occurrenceSpans": [],
      "retrievalText": "Aurora Labs Turin plant opening 2024",
      "proposition": {
        "subject": "Aurora Labs",
        "predicate": "opened a plant in",
        "object": "Turin",
        "qualifiers": ["in 2024"]
      },
      "attribution": {
        "kind": "direct_assertion",
        "attributedTo": null,
        "attributionSpan": null
      },
      "negated": false,
      "quantities": [],
      "time": {
        "statedText": "2024",
        "interval": {
          "earliest": "2024-01-01T00:00:00.000Z",
          "latest": "2024-12-31T23:59:59.000Z",
          "precision": "year",
          "timezone": null
        }
      },
      "place": "Turin",
      "unresolvedContext": [],
      "checkability": "checkable",
      "material": true,
      "parentClaimId": null,
      "duplicateOfClaimId": null,
      "coverageDisposition": "factual_claim"
    }
  ],
  "candidates": [
    {
      "id": "cand_complete_1",
      "claimId": "claim_complete_1",
      "query": "Aurora Labs Turin plant 2024",
      "queryIntent": "neutral",
      "provider": "example-search",
      "rank": 1,
      "discoveredAt": "2026-09-10T00:00:00.000Z",
      "proposedUrl": "https://records.example.org/turin-plant",
      "title": "Turin plant record",
      "snippet": "The Turin plant of Aurora Labs began operations in 2024.",
      "providerRating": null,
      "admissible": false
    }
  ],
  "assessments": [
    {
      "id": "assess_complete_1",
      "claimId": "claim_complete_1",
      "snapshotId": "snap_evidence_complete",
      "excerpt": {
        "span": {
          "start": 0,
          "end": 56
        },
        "quote": "The Turin plant of Aurora Labs began operations in 2024.",
        "locatorId": null
      },
      "relation": "supports",
      "applicability": {
        "temporal": "applicable",
        "entity": "applicable",
        "jurisdiction": "applicable",
        "scope": "applicable"
      },
      "directness": "primary",
      "dependencyGroupId": "origin_group_turin_plant",
      "dependence": "independent",
      "dependenceLocators": [],
      "method": {
        "name": "entailment-v2",
        "model": "example-model-id",
        "promptVersion": "core-prompts-2.0.0",
        "engineVersion": "core-v2.0.0"
      },
      "checks": [
        {
          "check": "quote_offsets",
          "result": "pass",
          "detail": "Offsets reproduce the quoted text."
        },
        {
          "check": "entity_identity",
          "result": "pass",
          "detail": "Aurora Labs matches the claim subject."
        },
        {
          "check": "temporal_scope",
          "result": "pass",
          "detail": "Both refer to 2024."
        }
      ],
      "calculation": null,
      "validationStatus": "validated",
      "justification": "The record states the plant began operations in 2024."
    }
  ],
  "provenance": [
    {
      "claimId": "claim_complete_1",
      "nodes": [
        {
          "snapshotId": "snap_evidence_complete",
          "role": "primary_record",
          "url": "https://records.example.org/turin-plant",
          "timestamps": [
            {
              "type": "published",
              "interval": {
                "earliest": "2024-06-01T00:00:00.000Z",
                "latest": "2024-06-01T00:00:00.000Z",
                "precision": "day",
                "timezone": "UTC"
              },
              "source": "structured_data",
              "locatorId": null
            }
          ],
          "claimPresentInContent": true
        }
      ],
      "edges": [],
      "candidateRoots": [
        {
          "snapshotId": "snap_evidence_complete",
          "rootKind": "primary_record",
          "rank": 1,
          "signals": [
            "Official register entry",
            "Earliest observed statement in the searched range"
          ]
        }
      ],
      "searchLog": [
        {
          "query": "Aurora Labs Turin plant 2024",
          "provider": "example-search",
          "executedAt": "2026-09-10T00:00:00.000Z",
          "resultCount": 1,
          "outcome": "results"
        }
      ],
      "searchedDateRange": {
        "earliest": "2024-01-01T00:00:00.000Z",
        "latest": "2026-09-10T00:00:00.000Z",
        "precision": "day",
        "timezone": "UTC"
      },
      "hopsUsed": 1,
      "chronologyConflicts": [],
      "cycles": [],
      "inaccessibleOriginals": [],
      "coverageStatus": "complete",
      "globalOriginClaimed": false
    }
  ],
  "decisions": [
    {
      "claimId": "claim_complete_1",
      "diagnosticLabel": "supported",
      "publishedLabel": "supported",
      "reasonCodes": ["supported_by_admissible_evidence"],
      "supportingAssessmentIds": ["assess_complete_1"],
      "contradictingAssessmentIds": [],
      "correctiveContextAssessmentIds": [],
      "justification": "An acquired primary record entails the scoped assertion.",
      "challenge": {
        "status": "resolved",
        "independentLabel": "supported",
        "agreed": true,
        "targetedRoundsUsed": 0,
        "notes": "The independent reassessment agreed without seeing the draft label."
      },
      "calibration": {
        "applicability": "in_scope",
        "calibratedCorrectness": 0.94,
        "calibratorVersion": "example-calibrator-0",
        "sliceId": "en/business/2026"
      },
      "rawModelConfidence": 0.88,
      "citationIntegrity": "valid"
    }
  ],
  "scorecard": {
    "formulaVersion": "factual-supported-share-1.0.0",
    "factualScore": 100,
    "nullReasons": [],
    "counts": {
      "supported": 1,
      "contradicted": 0,
      "misleading": 0,
      "mixed": 0,
      "unverified": 0,
      "eligibleFactualClaims": 1,
      "deferredClaims": 0,
      "omittedClaims": 0
    },
    "resolutionCoverage": 1,
    "extractionCoverage": 1,
    "inputStatus": "complete",
    "extractionStatus": "complete",
    "materialMixedOrMisleadingOpen": false,
    "evidence": {
      "admittedSnapshots": 1,
      "validatedAssessments": 1,
      "rejectedAssessments": 0,
      "needsHumanReviewAssessments": 0,
      "independentOriginGroups": 1,
      "unknownDependenceGroups": 0
    },
    "origin": {
      "claimsWithGraphs": 1,
      "claimsWithCandidateRoots": 1,
      "claimsWithUnresolvedChronology": 0,
      "inaccessibleOriginals": 0
    },
    "presentationFindings": []
  },
  "inputCoverage": [
    {
      "documentId": "snap_input_complete",
      "segments": [
        {
          "span": {
            "start": 0,
            "end": 44
          },
          "disposition": "factual_claim",
          "claimIds": ["claim_complete_1"],
          "reason": null
        }
      ],
      "charactersCovered": 44,
      "charactersTotal": 44,
      "extractionStatus": "complete"
    }
  ],
  "unresolvedReasons": [],
  "evidenceSetHash": "sha256:7f9a9cdaa4a1430815186c27c928283ffa51a12b280818e692175e3d7ca50b2e",
  "replayManifest": {
    "runId": "run_example_complete",
    "versions": {
      "engine": "core-v2.0.0",
      "prompt": "core-prompts-2.0.0",
      "model": "example-model-id",
      "retriever": "core-retriever-2.0.0",
      "embedding": {
        "model": "example-embedding-id",
        "dimensions": 1024,
        "preprocessing": "nfkc-lower-1"
      },
      "calibration": null
    },
    "seed": 20260910,
    "asOfTime": "2026-09-10T00:00:00.000Z",
    "inputHash": "sha256:f3878f1a6066eacd7439ee4c8932d6652888776559768b8c91c9c4724d947083",
    "evidenceSetHash": "sha256:7f9a9cdaa4a1430815186c27c928283ffa51a12b280818e692175e3d7ca50b2e",
    "snapshotIds": ["snap_input_complete", "snap_evidence_complete"],
    "assessmentIds": ["assess_complete_1"],
    "budget": {
      "maxExternalRequests": 120,
      "maxDiscoveryQueriesPerClaim": 12,
      "maxFetchedCandidatesPerClaim": 20,
      "maxProvenanceHops": 3,
      "maxTargetedRetrievalRounds": 2,
      "maxElapsedMs": 600000,
      "maxConcurrentExternalCalls": 3,
      "maxCostUsd": null
    }
  },
  "cost": {
    "externalRequests": 2,
    "inputTokens": null,
    "outputTokens": null,
    "costUsd": null,
    "latencyMs": 1200
  }
}
```

The `legacy` example in full:

```json
{
  "schemaVersion": 1,
  "checkId": "chk_legacy_0001",
  "createdAt": "2026-02-14T10:00:00.000Z",
  "headline": "Aurora Labs plant claim",
  "traceraScore": {
    "overall": 72
  }
}
```

The remaining five differ from `complete` in the fields below.

`partial` — truncated input, one deferred claim, score gated to null:

```json
{
  "status": "partial",
  "stageOutcomes": [
    {
      "stage": "normalize_input",
      "status": "partial",
      "issues": [
        {
          "code": "truncation",
          "severity": "warning",
          "message": "Input exceeded the character limit and was chunked.",
          "claimId": null,
          "snapshotId": null,
          "url": null
        }
      ],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    },
    {
      "stage": "extract_claims",
      "status": "partial",
      "issues": [
        {
          "code": "truncation",
          "severity": "warning",
          "message": "Input exceeded the character limit and was chunked.",
          "claimId": null,
          "snapshotId": null,
          "url": null
        }
      ],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    }
  ],
  "claims": [
    {
      "id": "claim_partial_deferred",
      "documentId": "snap_input_complete",
      "text": "The company also said exports doubled in 2025.",
      "spans": [
        {
          "start": 45,
          "end": 91
        }
      ],
      "occurrenceSpans": [],
      "retrievalText": "Aurora Labs exports doubled 2025",
      "proposition": {
        "subject": "Aurora Labs",
        "predicate": "said exports doubled",
        "object": null,
        "qualifiers": ["in 2025"]
      },
      "attribution": {
        "kind": "attributed_statement",
        "attributedTo": "Aurora Labs",
        "attributionSpan": {
          "start": 45,
          "end": 66
        }
      },
      "negated": false,
      "quantities": [
        {
          "rawText": "doubled",
          "value": 2,
          "unit": null,
          "denominatorText": null,
          "kind": "rate"
        }
      ],
      "time": {
        "statedText": "2025",
        "interval": {
          "earliest": "2025-01-01T00:00:00.000Z",
          "latest": "2025-12-31T23:59:59.000Z",
          "precision": "year",
          "timezone": null
        }
      },
      "place": null,
      "unresolvedContext": [],
      "checkability": "checkable",
      "material": true,
      "parentClaimId": null,
      "duplicateOfClaimId": null,
      "coverageDisposition": "deferred"
    }
  ],
  "scorecard": {
    "formulaVersion": "factual-supported-share-1.0.0",
    "factualScore": null,
    "nullReasons": ["partial_input", "partial_extraction"],
    "counts": {
      "supported": 1,
      "contradicted": 0,
      "misleading": 0,
      "mixed": 0,
      "unverified": 0,
      "eligibleFactualClaims": 1,
      "deferredClaims": 1,
      "omittedClaims": 0
    },
    "resolutionCoverage": 1,
    "extractionCoverage": 0.5,
    "inputStatus": "partial",
    "extractionStatus": "partial",
    "materialMixedOrMisleadingOpen": false,
    "evidence": {
      "admittedSnapshots": 1,
      "validatedAssessments": 1,
      "rejectedAssessments": 0,
      "needsHumanReviewAssessments": 0,
      "independentOriginGroups": 1,
      "unknownDependenceGroups": 0
    },
    "origin": {
      "claimsWithGraphs": 1,
      "claimsWithCandidateRoots": 1,
      "claimsWithUnresolvedChronology": 0,
      "inaccessibleOriginals": 0
    },
    "presentationFindings": []
  },
  "inputCoverage": [
    {
      "documentId": "snap_input_complete",
      "segments": [
        {
          "span": {
            "start": 0,
            "end": 44
          },
          "disposition": "factual_claim",
          "claimIds": ["claim_complete_1"],
          "reason": null
        },
        {
          "span": {
            "start": 45,
            "end": 91
          },
          "disposition": "deferred",
          "claimIds": ["claim_partial_deferred"],
          "reason": "The run budget was exhausted before this claim was retrieved."
        }
      ],
      "charactersCovered": 91,
      "charactersTotal": 91,
      "extractionStatus": "partial"
    }
  ],
  "unresolvedReasons": [
    {
      "code": "deferred_processing",
      "severity": "warning",
      "message": "One inventoried claim was not analyzed within the budget.",
      "claimId": null,
      "snapshotId": null,
      "url": null
    }
  ]
}
```

`unavailable` — the link was never read, so the slug stays a discovery hint and nothing
is scored:

```json
{
  "status": "unavailable",
  "snapshots": [
    {
      "contentHash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "rawContentHash": null,
      "originalUrl": "https://news.example.com/aurora-labs-turin-plant",
      "finalUrl": "https://news.example.com/aurora-labs-turin-plant",
      "canonicalUrl": null,
      "acquiredAt": "2026-09-10T00:00:00.000Z",
      "mimeType": "text/html",
      "language": "en",
      "role": "submitted_input",
      "extractionStatus": "blocked",
      "extractionMethod": "none",
      "limits": {
        "byteLimit": 5000000,
        "characterLimit": 200000,
        "bytesRetained": 0,
        "charactersRetained": 0,
        "truncated": false
      },
      "locators": [],
      "timestampAssertions": [],
      "discoveryHints": [
        {
          "kind": "url_slug",
          "text": "aurora-labs-turin-plant"
        }
      ],
      "blobLocator": {
        "status": "unavailable",
        "uri": null
      },
      "id": "snap_input_unavailable",
      "normalizedText": ""
    }
  ],
  "claims": [],
  "decisions": [],
  "scorecard": null,
  "inputCoverage": [
    {
      "documentId": "snap_input_unavailable",
      "segments": [],
      "charactersCovered": 0,
      "charactersTotal": 0,
      "extractionStatus": "unavailable"
    }
  ],
  "unresolvedReasons": [
    {
      "code": "blocked_page",
      "severity": "warning",
      "message": "The original content was never acquired, so nothing was scored.",
      "claimId": null,
      "snapshotId": null,
      "url": null
    }
  ],
  "evidenceSetHash": null
}
```

`ambiguous` — an unresolvable pronoun and referent keep the claim unverified:

```json
{
  "status": "partial",
  "claims": [
    {
      "id": "claim_ambiguous_1",
      "documentId": "snap_input_ambiguous",
      "text": "They said the figure doubled last year.",
      "spans": [
        {
          "start": 0,
          "end": 39
        }
      ],
      "occurrenceSpans": [],
      "retrievalText": "unspecified figure doubled last year",
      "proposition": {
        "subject": "They",
        "predicate": "said the figure doubled",
        "object": null,
        "qualifiers": ["last year"]
      },
      "attribution": {
        "kind": "attributed_statement",
        "attributedTo": null,
        "attributionSpan": {
          "start": 0,
          "end": 9
        }
      },
      "negated": false,
      "quantities": [
        {
          "rawText": "doubled",
          "value": 2,
          "unit": null,
          "denominatorText": null,
          "kind": "rate"
        }
      ],
      "time": {
        "statedText": "last year",
        "interval": {
          "earliest": null,
          "latest": null,
          "precision": null,
          "timezone": null
        }
      },
      "place": null,
      "unresolvedContext": [
        "The pronoun 'They' has no antecedent in the submitted text.",
        "'the figure' names no measurable quantity."
      ],
      "checkability": "needs_context",
      "material": true,
      "parentClaimId": null,
      "duplicateOfClaimId": null,
      "coverageDisposition": "factual_claim"
    }
  ],
  "decisions": [
    {
      "claimId": "claim_ambiguous_1",
      "diagnosticLabel": "unverified",
      "publishedLabel": "unverified",
      "reasonCodes": ["ambiguous_claim_scope", "unresolved_context"],
      "supportingAssessmentIds": [],
      "contradictingAssessmentIds": [],
      "correctiveContextAssessmentIds": [],
      "justification": "The proposition has no resolvable subject or quantity, so it is not checkable.",
      "challenge": {
        "status": "not_required",
        "independentLabel": null,
        "agreed": null,
        "targetedRoundsUsed": 0,
        "notes": "No decisive verdict was proposed."
      },
      "calibration": {
        "applicability": "out_of_scope",
        "calibratedCorrectness": null,
        "calibratorVersion": null,
        "reason": "Ambiguous claims are outside every validated calibration slice."
      },
      "rawModelConfidence": null,
      "citationIntegrity": "not_checked"
    }
  ],
  "scorecard": {
    "formulaVersion": "factual-supported-share-1.0.0",
    "factualScore": null,
    "nullReasons": ["zero_resolved_denominator", "resolution_coverage_below_threshold"],
    "counts": {
      "supported": 0,
      "contradicted": 0,
      "misleading": 0,
      "mixed": 0,
      "unverified": 1,
      "eligibleFactualClaims": 1,
      "deferredClaims": 0,
      "omittedClaims": 0
    },
    "resolutionCoverage": 0,
    "extractionCoverage": 1,
    "inputStatus": "complete",
    "extractionStatus": "complete",
    "materialMixedOrMisleadingOpen": false,
    "evidence": {
      "admittedSnapshots": 0,
      "validatedAssessments": 0,
      "rejectedAssessments": 0,
      "needsHumanReviewAssessments": 0,
      "independentOriginGroups": 0,
      "unknownDependenceGroups": 0
    },
    "origin": {
      "claimsWithGraphs": 0,
      "claimsWithCandidateRoots": 0,
      "claimsWithUnresolvedChronology": 0,
      "inaccessibleOriginals": 0
    },
    "presentationFindings": []
  }
}
```

`canceled` — a terminal state of its own that never carries a scorecard:

```json
{
  "status": "canceled",
  "stageOutcomes": [
    {
      "stage": "normalize_input",
      "status": "complete",
      "issues": [],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    },
    {
      "stage": "extract_claims",
      "status": "failed",
      "issues": [
        {
          "code": "cancellation_requested",
          "severity": "warning",
          "message": "The owner canceled the run.",
          "claimId": null,
          "snapshotId": null,
          "url": null
        }
      ],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    },
    {
      "stage": "retrieve_evidence",
      "status": "failed",
      "issues": [
        {
          "code": "cancellation_requested",
          "severity": "warning",
          "message": "The owner canceled the run.",
          "claimId": null,
          "snapshotId": null,
          "url": null
        }
      ],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    },
    {
      "stage": "assess_evidence",
      "status": "failed",
      "issues": [
        {
          "code": "cancellation_requested",
          "severity": "warning",
          "message": "The owner canceled the run.",
          "claimId": null,
          "snapshotId": null,
          "url": null
        }
      ],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    },
    {
      "stage": "trace_origins",
      "status": "failed",
      "issues": [
        {
          "code": "cancellation_requested",
          "severity": "warning",
          "message": "The owner canceled the run.",
          "claimId": null,
          "snapshotId": null,
          "url": null
        }
      ],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    },
    {
      "stage": "adjudicate_claims",
      "status": "failed",
      "issues": [
        {
          "code": "cancellation_requested",
          "severity": "warning",
          "message": "The owner canceled the run.",
          "claimId": null,
          "snapshotId": null,
          "url": null
        }
      ],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    },
    {
      "stage": "calibrate_decisions",
      "status": "failed",
      "issues": [
        {
          "code": "cancellation_requested",
          "severity": "warning",
          "message": "The owner canceled the run.",
          "claimId": null,
          "snapshotId": null,
          "url": null
        }
      ],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    },
    {
      "stage": "score_report",
      "status": "failed",
      "issues": [
        {
          "code": "cancellation_requested",
          "severity": "warning",
          "message": "The owner canceled the run.",
          "claimId": null,
          "snapshotId": null,
          "url": null
        }
      ],
      "metrics": {
        "startedAt": "2026-09-10T00:00:00.000Z",
        "completedAt": "2026-09-10T00:00:00.000Z",
        "durationMs": 10,
        "externalRequests": 0,
        "inputTokens": null,
        "outputTokens": null,
        "costUsd": null
      }
    }
  ],
  "claims": [],
  "decisions": [],
  "scorecard": null,
  "inputCoverage": [],
  "unresolvedReasons": [
    {
      "code": "cancellation_requested",
      "severity": "warning",
      "message": "Leases and spend reservations were released.",
      "claimId": null,
      "snapshotId": null,
      "url": null
    }
  ]
}
```

`noClaim` — opinion-only input reports no checkable claims, never zero accuracy:

```json
{
  "status": "complete",
  "claims": [
    {
      "id": "claim_no_claim_1",
      "documentId": "snap_input_no_claim",
      "text": "The new plant is a wonderful idea.",
      "spans": [
        {
          "start": 0,
          "end": 42
        }
      ],
      "occurrenceSpans": [],
      "retrievalText": "new plant wonderful idea",
      "proposition": {
        "subject": "the new plant",
        "predicate": "is",
        "object": "a wonderful idea",
        "qualifiers": []
      },
      "attribution": {
        "kind": "direct_assertion",
        "attributedTo": null,
        "attributionSpan": null
      },
      "negated": false,
      "quantities": [],
      "time": {
        "statedText": null,
        "interval": {
          "earliest": null,
          "latest": null,
          "precision": null,
          "timezone": null
        }
      },
      "place": null,
      "unresolvedContext": [],
      "checkability": "not_checkable",
      "material": false,
      "parentClaimId": null,
      "duplicateOfClaimId": null,
      "coverageDisposition": "opinion"
    }
  ],
  "decisions": [],
  "scorecard": {
    "formulaVersion": "factual-supported-share-1.0.0",
    "factualScore": null,
    "nullReasons": ["no_checkable_claims", "zero_resolved_denominator"],
    "counts": {
      "supported": 0,
      "contradicted": 0,
      "misleading": 0,
      "mixed": 0,
      "unverified": 0,
      "eligibleFactualClaims": 0,
      "deferredClaims": 0,
      "omittedClaims": 0
    },
    "resolutionCoverage": null,
    "extractionCoverage": 1,
    "inputStatus": "complete",
    "extractionStatus": "complete",
    "materialMixedOrMisleadingOpen": false,
    "evidence": {
      "admittedSnapshots": 0,
      "validatedAssessments": 0,
      "rejectedAssessments": 0,
      "needsHumanReviewAssessments": 0,
      "independentOriginGroups": 0,
      "unknownDependenceGroups": 0
    },
    "origin": {
      "claimsWithGraphs": 0,
      "claimsWithCandidateRoots": 0,
      "claimsWithUnresolvedChronology": 0,
      "inaccessibleOriginals": 0
    },
    "presentationFindings": []
  },
  "inputCoverage": [
    {
      "documentId": "snap_input_no_claim",
      "segments": [
        {
          "span": {
            "start": 0,
            "end": 42
          },
          "disposition": "opinion",
          "claimIds": ["claim_no_claim_1"],
          "reason": "The sentence states a preference, not a checkable proposition."
        }
      ],
      "charactersCovered": 42,
      "charactersTotal": 42,
      "extractionStatus": "complete"
    }
  ]
}
```

## Scope of the freeze

Frozen here: entity shapes, enumerations, the fifteen runtime invariants above, the port
interfaces and the nine stage signatures.

Not frozen here, and owned by later tasks: how content hashes are computed and verified
against stored bytes (task 03), extraction fidelity and span exactness (tasks 04 and 05),
retrieval budgets in practice (task 06), dependence detection (task 07), root ranking
(task 08), the calibrator and its thresholds (tasks 09 and 12), and the API and UI
projections of `RunReport` (task 11).

Task 01's evaluation adapter now types its truth labels from `claimLabelSchema` and
declares an `EvaluationContractVersion`; the v1 adapter reports `legacy-v1`. The six-case
model-validation runner, the fixture dataset and the `not_evaluated` semantics for
zero-denominator metrics are unchanged.
