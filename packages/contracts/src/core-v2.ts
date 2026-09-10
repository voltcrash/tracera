/*
 * Frozen v2 core contracts. Every downstream core stage imports these schemas
 * and types; parallel models are not permitted. Legacy v1 contracts in
 * ./index.ts stay operational and are unchanged.
 *
 * Offsets are half-open UTF-16 code-unit ranges into the referenced snapshot
 * text. Unknown values are explicit null, never a fabricated timestamp, score
 * or confidence. Core evidence objects are strict: there is no free-form JSON
 * escape hatch anywhere in this file.
 */
import { z } from "zod";

export const CORE_V2_SCHEMA_VERSION = 2 as const;
export const CORE_V2_CONTRACT_VERSION = "2.0.0" as const;
export const CORE_V2_SCORE_FORMULA_VERSION = "factual-supported-share-1.0.0" as const;
export const CORE_V2_RESOLUTION_COVERAGE_THRESHOLD = 0.8 as const;

/** Starting evaluation-only caps from the plan. Not a production spend approval. */
export const CORE_V2_EVALUATION_BUDGET = {
  maxExternalRequests: 120,
  maxDiscoveryQueriesPerClaim: 12,
  maxFetchedCandidatesPerClaim: 20,
  maxProvenanceHops: 3,
  maxTargetedRetrievalRounds: 2,
  maxElapsedMs: 600_000,
  maxConcurrentExternalCalls: 3,
  maxCostUsd: null,
} as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const contentHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const instantSchema = z.string().datetime({ offset: true });
export const probabilitySchema = z.number().min(0).max(1).finite();
export const percentageSchema = z.number().min(0).max(100).finite();
export const nonNegativeIntSchema = z.number().int().nonnegative();

/** Half-open UTF-16 code-unit range: text.slice(start, end). */
export const spanSchema = z
  .strictObject({ start: nonNegativeIntSchema, end: z.number().int().positive() })
  .refine((value) => value.start < value.end, "Span end must be greater than span start.");

export const boundingBoxSchema = z.strictObject({
  page: nonNegativeIntSchema,
  frameId: z.string().min(1).nullable(),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

export const timePrecisionSchema = z.enum(["year", "month", "day", "hour", "minute", "second"]);

/** An unknown time is `{ earliest: null, latest: null }`, never a guessed instant. */
export const timeIntervalSchema = z
  .strictObject({
    earliest: instantSchema.nullable(),
    latest: instantSchema.nullable(),
    precision: timePrecisionSchema.nullable(),
    timezone: z.string().min(1).nullable(),
  })
  .refine(
    (value) =>
      value.earliest === null ||
      value.latest === null ||
      Date.parse(value.earliest) <= Date.parse(value.latest),
    "Interval earliest must not be after latest.",
  );

export const visibilitySchema = z.enum(["private", "unlisted", "public"]);
export const executionModeSchema = z.enum(["fixture", "replay", "live", "shadow"]);

// ---------------------------------------------------------------------------
// Stage status, typed issues and stage results
// ---------------------------------------------------------------------------

export const stageStatusSchema = z.enum(["complete", "partial", "unavailable", "failed"]);
export const runStatusSchema = z.enum(["complete", "partial", "unavailable", "failed", "canceled"]);

export const stageNameSchema = z.enum([
  "normalize_input",
  "extract_claims",
  "retrieve_evidence",
  "assess_evidence",
  "trace_origins",
  "adjudicate_claims",
  "calibrate_decisions",
  "score_report",
]);

/** A provider failure must never be reportable as a completed empty search. */
export const issueCodeSchema = z.enum([
  "missing_evidence",
  "provider_failure",
  "provider_outage",
  "rate_limited",
  "timeout",
  "capability_unavailable",
  "content_unavailable",
  "blocked_page",
  "unsupported_format",
  "unsupported_language",
  "ambiguous_input",
  "truncation",
  "budget_exhausted",
  "cancellation_requested",
  "snapshot_unavailable",
  "citation_validation_failed",
  "calibration_unavailable",
  "dependency_unknown",
  "human_review_required",
  "deferred_processing",
]);

export const issueSchema = z.strictObject({
  code: issueCodeSchema,
  severity: z.enum(["info", "warning", "error"]),
  message: z.string().min(1),
  claimId: z.string().min(1).nullable(),
  snapshotId: z.string().min(1).nullable(),
  url: z.string().url().nullable(),
});

export const stageMetricsSchema = z.strictObject({
  startedAt: instantSchema,
  completedAt: instantSchema,
  durationMs: z.number().nonnegative().finite(),
  externalRequests: nonNegativeIntSchema,
  inputTokens: nonNegativeIntSchema.nullable(),
  outputTokens: nonNegativeIntSchema.nullable(),
  costUsd: z.number().nonnegative().finite().nullable(),
});

/**
 * Every stage returns `{status, data, issues, metrics}`. `complete` and
 * `partial` carry data; `unavailable` and `failed` never do.
 */
export function stageResultSchema<Data extends z.ZodType>(data: Data) {
  return z
    .strictObject({
      status: stageStatusSchema,
      data: data.nullable(),
      issues: z.array(issueSchema),
      metrics: stageMetricsSchema,
    })
    .superRefine((raw, context) => {
      const value = raw as unknown as {
        status: z.infer<typeof stageStatusSchema>;
        data: unknown;
        issues: unknown[];
      };
      const carriesData = value.status === "complete" || value.status === "partial";
      if (carriesData && value.data === null) {
        context.addIssue({
          code: "custom",
          path: ["data"],
          message: "A complete or partial stage must return data.",
        });
      }
      if (!carriesData && value.data !== null) {
        context.addIssue({
          code: "custom",
          path: ["data"],
          message: "An unavailable or failed stage must not return data.",
        });
      }
      if (value.status !== "complete" && value.issues.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["issues"],
          message: "A non-complete stage must state at least one typed issue.",
        });
      }
    });
}

export interface StageResult<Data> {
  status: z.infer<typeof stageStatusSchema>;
  data: Data | null;
  issues: Array<z.infer<typeof issueSchema>>;
  metrics: z.infer<typeof stageMetricsSchema>;
}

// ---------------------------------------------------------------------------
// Run context
// ---------------------------------------------------------------------------

export const engineVersionsSchema = z.strictObject({
  engine: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  retriever: z.string().min(1),
  embedding: z.strictObject({
    model: z.string().min(1),
    dimensions: z.number().int().positive(),
    preprocessing: z.string().min(1),
  }),
  calibration: z.string().min(1).nullable(),
});

export const runBudgetSchema = z.strictObject({
  maxExternalRequests: z.number().int().positive(),
  maxDiscoveryQueriesPerClaim: z.number().int().positive(),
  maxFetchedCandidatesPerClaim: z.number().int().positive(),
  maxProvenanceHops: z.number().int().positive(),
  maxTargetedRetrievalRounds: nonNegativeIntSchema,
  maxElapsedMs: z.number().int().positive(),
  maxConcurrentExternalCalls: z.number().int().positive(),
  maxCostUsd: z.number().positive().finite().nullable(),
});

export const cancellationStateSchema = z
  .strictObject({
    requested: z.boolean(),
    requestedAt: instantSchema.nullable(),
    reason: z.enum(["user_request", "operator_request", "budget_exhausted", "timeout"]).nullable(),
  })
  .refine(
    (value) => value.requested === (value.requestedAt !== null && value.reason !== null),
    "A requested cancellation needs a time and a reason; an unrequested one needs neither.",
  );

/**
 * Serializable run identity. Live ports (generation, storage, clock, audit
 * sink) and the AbortSignal travel beside it in the engine's RunEnvironment,
 * never inside the persisted contract.
 */
export const runContextSchema = z.strictObject({
  runId: z.string().min(1),
  tenantId: z.string().min(1),
  ownerUserId: z.string().min(1),
  visibility: visibilitySchema,
  inputHash: contentHashSchema,
  asOfTime: instantSchema,
  versions: engineVersionsSchema,
  executionMode: executionModeSchema,
  budget: runBudgetSchema,
  cancellation: cancellationStateSchema,
  auditSinkId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Document snapshots
// ---------------------------------------------------------------------------

export const extractionStatusSchema = z.enum([
  "complete",
  "partial",
  "content_unavailable",
  "unsupported_format",
  "blocked",
]);

export const locatorKindSchema = z.enum([
  "title",
  "heading",
  "paragraph",
  "list_item",
  "table",
  "table_cell",
  "caption",
  "quote",
  "alt_text",
  "ocr_text",
  "user_caption",
]);

export const locatorSchema = z.strictObject({
  id: z.string().min(1),
  kind: locatorKindSchema,
  path: z.string().min(1),
  span: spanSchema,
  boundingBox: boundingBoxSchema.nullable(),
  transcriptionUncertain: z.boolean(),
});

export const timestampSourceSchema = z.enum([
  "http_header",
  "html_meta",
  "structured_data",
  "visible_text",
  "archive_service",
  "provider_api",
  "user_supplied",
]);

export const timestampAssertionSchema = z.strictObject({
  type: z.enum(["published", "updated", "event", "indexed", "archived", "captured"]),
  interval: timeIntervalSchema,
  source: timestampSourceSchema,
  locatorId: z.string().min(1).nullable(),
});

/** A slug or headline guess is a discovery hint. It is never a factual claim. */
export const discoveryHintSchema = z.strictObject({
  kind: z.enum(["url_slug", "link_title", "search_snippet", "user_caption"]),
  text: z.string().min(1),
});

export const documentSnapshotSchema = z.strictObject({
  id: z.string().min(1),
  contentHash: contentHashSchema,
  rawContentHash: contentHashSchema.nullable(),
  originalUrl: z.string().url().nullable(),
  finalUrl: z.string().url().nullable(),
  canonicalUrl: z.string().url().nullable(),
  acquiredAt: instantSchema,
  mimeType: z.string().min(1).nullable(),
  language: z.string().min(2).nullable(),
  role: z.enum(["submitted_input", "evidence", "archive_capture", "primary_record"]),
  normalizedText: z.string(),
  extractionStatus: extractionStatusSchema,
  extractionMethod: z.enum([
    "structured_html",
    "reader_fallback",
    "plain_text",
    "ocr",
    "user_supplied",
    "none",
  ]),
  limits: z.strictObject({
    byteLimit: z.number().int().positive(),
    characterLimit: z.number().int().positive(),
    bytesRetained: nonNegativeIntSchema,
    charactersRetained: nonNegativeIntSchema,
    truncated: z.boolean(),
  }),
  locators: z.array(locatorSchema),
  timestampAssertions: z.array(timestampAssertionSchema),
  discoveryHints: z.array(discoveryHintSchema),
  blobLocator: z.strictObject({
    status: z.enum(["stored", "unavailable"]),
    uri: z.string().min(1).nullable(),
  }),
});

// ---------------------------------------------------------------------------
// Claims and input coverage
// ---------------------------------------------------------------------------

export const checkabilitySchema = z.enum([
  "checkable",
  "needs_context",
  "unanswerable",
  "not_checkable",
]);

export const coverageDispositionSchema = z.enum([
  "factual_claim",
  "opinion",
  "background",
  "non_checkable",
  "deferred",
]);

export const quantitySchema = z.strictObject({
  rawText: z.string().min(1),
  value: z.number().finite().nullable(),
  unit: z.string().min(1).nullable(),
  denominatorText: z.string().min(1).nullable(),
  kind: z.enum(["count", "rate", "percentage", "currency", "duration", "measure", "unknown"]),
});

export const attributionSchema = z.strictObject({
  kind: z.enum(["direct_assertion", "attributed_statement", "quotation"]),
  attributedTo: z.string().min(1).nullable(),
  attributionSpan: spanSchema.nullable(),
});

export const claimSchema = z.strictObject({
  id: z.string().min(1),
  documentId: z.string().min(1),
  text: z.string().min(1),
  spans: z.array(spanSchema).min(1),
  occurrenceSpans: z.array(spanSchema),
  retrievalText: z.string().min(1),
  proposition: z.strictObject({
    subject: z.string().min(1),
    predicate: z.string().min(1),
    object: z.string().min(1).nullable(),
    qualifiers: z.array(z.string().min(1)),
  }),
  attribution: attributionSchema,
  negated: z.boolean(),
  quantities: z.array(quantitySchema),
  time: z.strictObject({
    statedText: z.string().min(1).nullable(),
    interval: timeIntervalSchema,
  }),
  place: z.string().min(1).nullable(),
  unresolvedContext: z.array(z.string().min(1)),
  checkability: checkabilitySchema,
  material: z.boolean(),
  parentClaimId: z.string().min(1).nullable(),
  duplicateOfClaimId: z.string().min(1).nullable(),
  coverageDisposition: coverageDispositionSchema,
});

export const inputCoverageSchema = z
  .strictObject({
    documentId: z.string().min(1),
    segments: z.array(
      z.strictObject({
        span: spanSchema,
        disposition: coverageDispositionSchema,
        claimIds: z.array(z.string().min(1)),
        reason: z.string().min(1).nullable(),
      }),
    ),
    charactersCovered: nonNegativeIntSchema,
    charactersTotal: nonNegativeIntSchema,
    extractionStatus: stageStatusSchema,
  })
  .refine(
    (value) => value.charactersCovered <= value.charactersTotal,
    "Covered characters cannot exceed the document length.",
  );

// ---------------------------------------------------------------------------
// Evidence candidates and assessments
// ---------------------------------------------------------------------------

export const queryIntentSchema = z.enum([
  "neutral",
  "supporting",
  "disconfirming",
  "primary_source",
  "date_constrained",
  "origin_trace",
]);

/** A candidate is a discovery record. `admissible` is structurally false. */
export const evidenceCandidateSchema = z.strictObject({
  id: z.string().min(1),
  claimId: z.string().min(1),
  query: z.string().min(1),
  queryIntent: queryIntentSchema,
  provider: z.string().min(1),
  rank: nonNegativeIntSchema,
  discoveredAt: instantSchema,
  proposedUrl: z.string().url(),
  title: z.string().min(1).nullable(),
  snippet: z.string().min(1).nullable(),
  providerRating: z.string().min(1).nullable(),
  admissible: z.literal(false),
});

export const evidenceRelationSchema = z.enum([
  "supports",
  "contradicts",
  "context",
  "irrelevant",
  "insufficient",
]);

export const applicabilityValueSchema = z.enum(["applicable", "not_applicable", "uncertain"]);

export const directnessSchema = z.enum(["primary", "secondary", "derivative", "unknown"]);

export const dependenceRelationSchema = z.enum([
  "independent",
  "syndicated_copy",
  "cites_source",
  "quotes_source",
  "same_publisher",
  "unknown",
]);

export const assessmentCheckSchema = z.strictObject({
  check: z.enum([
    "quote_offsets",
    "citation_reference",
    "entity_identity",
    "temporal_scope",
    "jurisdiction",
    "negation",
    "attribution",
    "units",
    "denominator",
    "calculation",
  ]),
  result: z.enum(["pass", "fail", "not_applicable"]),
  detail: z.string().min(1),
});

export const calculationStepSchema = z.strictObject({
  expression: z.string().min(1),
  value: z.number().finite(),
  unit: z.string().min(1).nullable(),
});

export const evidenceAssessmentSchema = z
  .strictObject({
    id: z.string().min(1),
    claimId: z.string().min(1),
    snapshotId: z.string().min(1),
    excerpt: z.strictObject({
      span: spanSchema,
      quote: z.string().min(1),
      locatorId: z.string().min(1).nullable(),
    }),
    relation: evidenceRelationSchema,
    applicability: z.strictObject({
      temporal: applicabilityValueSchema,
      entity: applicabilityValueSchema,
      jurisdiction: applicabilityValueSchema,
      scope: applicabilityValueSchema,
    }),
    directness: directnessSchema,
    dependencyGroupId: z.string().min(1),
    dependence: dependenceRelationSchema,
    dependenceLocators: z.array(
      z.strictObject({
        snapshotId: z.string().min(1),
        span: spanSchema,
        quote: z.string().min(1),
      }),
    ),
    method: z.strictObject({
      name: z.string().min(1),
      model: z.string().min(1).nullable(),
      promptVersion: z.string().min(1).nullable(),
      engineVersion: z.string().min(1),
    }),
    checks: z.array(assessmentCheckSchema).min(1),
    calculation: z
      .strictObject({
        steps: z.array(calculationStepSchema).min(1),
        result: z.number().finite().nullable(),
      })
      .nullable(),
    validationStatus: z.enum(["validated", "rejected", "needs_human_review"]),
    justification: z.string().min(1),
  })
  .superRefine((value, context) => {
    const failed = value.checks.some((check) => check.result === "fail");
    if (failed && value.validationStatus === "validated") {
      context.addIssue({
        code: "custom",
        path: ["validationStatus"],
        message: "An assessment with a failed check cannot be validated.",
      });
    }
    if (value.dependence !== "independent" && value.dependence !== "unknown") {
      if (value.dependenceLocators.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["dependenceLocators"],
          message: "A stated dependence relation must cite supporting locators.",
        });
      }
    }
  });

/** Returned by assessment for task 06's at most two targeted retrieval rounds. */
export const sufficiencyFeedbackSchema = z.strictObject({
  claimId: z.string().min(1),
  sufficient: z.boolean(),
  missing: z.array(
    z.enum([
      "primary_record",
      "disconfirming_evidence",
      "independent_origin",
      "time_applicable_evidence",
      "jurisdiction_applicable_evidence",
      "numeric_operands",
      "full_document_acquisition",
    ]),
  ),
  suggestedQueries: z.array(
    z.strictObject({ query: z.string().min(1), intent: queryIntentSchema }),
  ),
  independentOriginCount: nonNegativeIntSchema,
  unknownDependenceCount: nonNegativeIntSchema,
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export const provenanceNodeRoleSchema = z.enum([
  "submitted_input",
  "primary_record",
  "report",
  "aggregator",
  "syndication",
  "archive_capture",
  "index",
  "corpus_record",
]);

export const provenanceEdgeTypeSchema = z.enum([
  "cites",
  "attributes_to",
  "republishes",
  "archives",
  "indexes",
  "updates",
  "contradicts_chronology",
]);

export const rootKindSchema = z.enum([
  "primary_record",
  "earliest_observed_statement",
  "earliest_retrieved_report",
]);

export const provenanceGraphSchema = z
  .strictObject({
    claimId: z.string().min(1),
    nodes: z.array(
      z.strictObject({
        snapshotId: z.string().min(1),
        role: provenanceNodeRoleSchema,
        url: z.string().url().nullable(),
        timestamps: z.array(timestampAssertionSchema),
        claimPresentInContent: z.boolean(),
      }),
    ),
    edges: z.array(
      z.strictObject({
        fromSnapshotId: z.string().min(1),
        toSnapshotId: z.string().min(1),
        type: provenanceEdgeTypeSchema,
        supportingLocators: z
          .array(
            z.strictObject({
              snapshotId: z.string().min(1),
              span: spanSchema,
              quote: z.string().min(1),
            }),
          )
          .min(1),
      }),
    ),
    candidateRoots: z.array(
      z.strictObject({
        snapshotId: z.string().min(1),
        rootKind: rootKindSchema,
        rank: z.number().int().positive(),
        signals: z.array(z.string().min(1)).min(1),
      }),
    ),
    searchLog: z.array(
      z.strictObject({
        query: z.string().min(1),
        provider: z.string().min(1),
        executedAt: instantSchema,
        resultCount: nonNegativeIntSchema,
        outcome: z.enum(["results", "no_results", "outage", "unsupported", "budget_exhausted"]),
      }),
    ),
    searchedDateRange: timeIntervalSchema,
    hopsUsed: nonNegativeIntSchema,
    chronologyConflicts: z.array(
      z.strictObject({
        snapshotIds: z.array(z.string().min(1)).min(2),
        description: z.string().min(1),
      }),
    ),
    cycles: z.array(z.array(z.string().min(1)).min(2)),
    inaccessibleOriginals: z.array(
      z.strictObject({ url: z.string().url(), reason: issueCodeSchema }),
    ),
    coverageStatus: stageStatusSchema,
    /** Output wording is always "earliest observed", never a global first source. */
    globalOriginClaimed: z.literal(false),
  })
  .superRefine((value, context) => {
    const nodeIds = new Set(value.nodes.map((node) => node.snapshotId));
    for (const [index, edge] of value.edges.entries()) {
      if (!nodeIds.has(edge.fromSnapshotId)) {
        addDangling(context, ["edges", index, "fromSnapshotId"], edge.fromSnapshotId);
      }
      if (!nodeIds.has(edge.toSnapshotId)) {
        addDangling(context, ["edges", index, "toSnapshotId"], edge.toSnapshotId);
      }
    }
    for (const [index, root] of value.candidateRoots.entries()) {
      if (!nodeIds.has(root.snapshotId)) {
        addDangling(context, ["candidateRoots", index, "snapshotId"], root.snapshotId);
      }
    }
  });

// ---------------------------------------------------------------------------
// Decisions and calibration
// ---------------------------------------------------------------------------

export const claimLabelSchema = z.enum([
  "supported",
  "contradicted",
  "misleading",
  "mixed",
  "unverified",
]);

export const decisiveLabels = ["supported", "contradicted", "misleading"] as const;

export const decisionReasonCodeSchema = z.enum([
  "supported_by_admissible_evidence",
  "contradicted_by_admissible_evidence",
  "material_distortion_with_corrective_context",
  "unresolved_material_conflict",
  "no_admissible_evidence",
  "evidence_not_applicable_in_time",
  "evidence_not_applicable_to_entity",
  "evidence_not_applicable_in_jurisdiction",
  "insufficient_independent_origins",
  "citation_validation_failed",
  "ambiguous_claim_scope",
  "unresolved_context",
  "unresolved_challenge_disagreement",
  "calibration_unavailable",
  "calibration_out_of_scope",
  "budget_exhausted_before_resolution",
  "source_unavailable",
  "unsupported_language",
  "awaiting_deferred_processing",
  "no_checkable_proposition",
]);

/**
 * Calibrated correctness is the probability the emitted label is correct under
 * the annotation policy. It exists only inside a validated calibration slice.
 */
export const calibrationSchema = z.discriminatedUnion("applicability", [
  z.strictObject({
    applicability: z.literal("in_scope"),
    calibratedCorrectness: probabilitySchema,
    calibratorVersion: z.string().min(1),
    sliceId: z.string().min(1),
  }),
  z.strictObject({
    applicability: z.enum(["unavailable", "out_of_scope", "invalidated"]),
    calibratedCorrectness: z.null(),
    calibratorVersion: z.string().min(1).nullable(),
    reason: z.string().min(1),
  }),
]);

export const challengeSchema = z.strictObject({
  status: z.enum(["not_required", "resolved", "unresolved", "failed"]),
  independentLabel: claimLabelSchema.nullable(),
  agreed: z.boolean().nullable(),
  targetedRoundsUsed: nonNegativeIntSchema,
  notes: z.string().min(1),
});

export const decisionSchema = z
  .strictObject({
    claimId: z.string().min(1),
    /** Adjudicated label before release gating. Diagnostic and evaluation use only. */
    diagnosticLabel: claimLabelSchema,
    /** The label released to users. Gated by calibration, challenge and citations. */
    publishedLabel: claimLabelSchema,
    reasonCodes: z.array(decisionReasonCodeSchema).min(1),
    supportingAssessmentIds: z.array(z.string().min(1)),
    contradictingAssessmentIds: z.array(z.string().min(1)),
    correctiveContextAssessmentIds: z.array(z.string().min(1)),
    justification: z.string().min(1),
    challenge: challengeSchema,
    calibration: calibrationSchema,
    /** Model self-reports are diagnostic. They are never a calibrated probability. */
    rawModelConfidence: probabilitySchema.nullable(),
    citationIntegrity: z.enum(["valid", "invalid", "not_checked"]),
  })
  .superRefine((value, context) => {
    const publishable =
      value.calibration.applicability === "in_scope" &&
      value.challenge.status === "resolved" &&
      value.citationIntegrity === "valid";
    const isDecisive = (decisiveLabels as readonly string[]).includes(value.publishedLabel);

    if (isDecisive && !publishable) {
      context.addIssue({
        code: "custom",
        path: ["publishedLabel"],
        message:
          "A decisive published label requires in-scope calibration, a resolved challenge and valid citations.",
      });
    }
    if (value.publishedLabel === "supported" && value.supportingAssessmentIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["supportingAssessmentIds"],
        message: "A supported decision must reference supporting assessments.",
      });
    }
    if (value.publishedLabel === "contradicted" && value.contradictingAssessmentIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["contradictingAssessmentIds"],
        message: "A contradicted decision must reference contradicting assessments.",
      });
    }
    if (value.publishedLabel === "misleading") {
      if (
        value.supportingAssessmentIds.length === 0 ||
        value.correctiveContextAssessmentIds.length === 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["correctiveContextAssessmentIds"],
          message:
            "A misleading decision must cite both the stated assertion and the corrective context.",
        });
      }
    }
    if (
      value.publishedLabel === "mixed" &&
      (value.supportingAssessmentIds.length === 0 || value.contradictingAssessmentIds.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["contradictingAssessmentIds"],
        message: "A mixed decision must cite both supporting and contradicting assessments.",
      });
    }
  });

// ---------------------------------------------------------------------------
// Scorecard and presentation
// ---------------------------------------------------------------------------

export const scoreNullReasonSchema = z.enum([
  "zero_resolved_denominator",
  "no_checkable_claims",
  "partial_input",
  "partial_extraction",
  "resolution_coverage_below_threshold",
  "material_mixed_or_misleading_open",
  "run_canceled",
  "run_failed",
]);

export const presentationFindingSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum([
    "emotional_language",
    "attributed_quotation",
    "negative_reporting",
    "material_context_omission",
    "material_skew",
  ]),
  /** Text-observed findings cite submitted spans only. */
  submittedSpans: z.array(spanSchema).min(1),
  /** Evidence-backed findings additionally cite assessments; tone findings do not. */
  evidenceAssessmentIds: z.array(z.string().min(1)),
  evidenceBacked: z.boolean(),
  description: z.string().min(1),
});

export const originSummarySchema = z.strictObject({
  claimsWithGraphs: nonNegativeIntSchema,
  claimsWithCandidateRoots: nonNegativeIntSchema,
  claimsWithUnresolvedChronology: nonNegativeIntSchema,
  inaccessibleOriginals: nonNegativeIntSchema,
});

export const evidenceSummarySchema = z.strictObject({
  admittedSnapshots: nonNegativeIntSchema,
  validatedAssessments: nonNegativeIntSchema,
  rejectedAssessments: nonNegativeIntSchema,
  needsHumanReviewAssessments: nonNegativeIntSchema,
  independentOriginGroups: nonNegativeIntSchema,
  unknownDependenceGroups: nonNegativeIntSchema,
});

export const scorecardSchema = z
  .strictObject({
    formulaVersion: z.literal(CORE_V2_SCORE_FORMULA_VERSION),
    /** 100 * supported / (supported + contradicted). Null whenever gated. */
    factualScore: percentageSchema.nullable(),
    nullReasons: z.array(scoreNullReasonSchema),
    counts: z.strictObject({
      supported: nonNegativeIntSchema,
      contradicted: nonNegativeIntSchema,
      misleading: nonNegativeIntSchema,
      mixed: nonNegativeIntSchema,
      unverified: nonNegativeIntSchema,
      eligibleFactualClaims: nonNegativeIntSchema,
      deferredClaims: nonNegativeIntSchema,
      omittedClaims: nonNegativeIntSchema,
    }),
    resolutionCoverage: probabilitySchema.nullable(),
    extractionCoverage: probabilitySchema.nullable(),
    inputStatus: stageStatusSchema,
    extractionStatus: stageStatusSchema,
    materialMixedOrMisleadingOpen: z.boolean(),
    evidence: evidenceSummarySchema,
    origin: originSummarySchema,
    presentationFindings: z.array(presentationFindingSchema),
  })
  .superRefine((value, context) => {
    const { counts } = value;
    const resolved = counts.supported + counts.contradicted;
    const labeled = resolved + counts.misleading + counts.mixed + counts.unverified;
    if (labeled !== counts.eligibleFactualClaims) {
      context.addIssue({
        code: "custom",
        path: ["counts", "eligibleFactualClaims"],
        message: "Verdict counts must sum to the eligible factual claim count.",
      });
    }

    const expectedCoverage =
      counts.eligibleFactualClaims === 0 ? null : resolved / counts.eligibleFactualClaims;
    if (!nearlyEqual(value.resolutionCoverage, expectedCoverage)) {
      context.addIssue({
        code: "custom",
        path: ["resolutionCoverage"],
        message: "Resolution coverage must equal resolved divided by eligible factual claims.",
      });
    }

    const required = new Set<z.infer<typeof scoreNullReasonSchema>>();
    if (counts.eligibleFactualClaims === 0) required.add("no_checkable_claims");
    if (resolved === 0) required.add("zero_resolved_denominator");
    if (value.inputStatus !== "complete") required.add("partial_input");
    if (value.extractionStatus !== "complete") required.add("partial_extraction");
    if (
      value.resolutionCoverage !== null &&
      value.resolutionCoverage < CORE_V2_RESOLUTION_COVERAGE_THRESHOLD
    ) {
      required.add("resolution_coverage_below_threshold");
    }
    if (value.materialMixedOrMisleadingOpen) required.add("material_mixed_or_misleading_open");

    for (const reason of required) {
      if (!value.nullReasons.includes(reason)) {
        context.addIssue({
          code: "custom",
          path: ["nullReasons"],
          message: `Missing required score null reason: ${reason}.`,
        });
      }
    }

    if (value.nullReasons.length > 0 && value.factualScore !== null) {
      context.addIssue({
        code: "custom",
        path: ["factualScore"],
        message: "A gated scorecard must report a null factual score.",
      });
    }
    if (value.nullReasons.length === 0) {
      if (value.factualScore === null) {
        context.addIssue({
          code: "custom",
          path: ["factualScore"],
          message: "An ungated scorecard must report a factual score.",
        });
      } else if (!nearlyEqual(value.factualScore, (100 * counts.supported) / resolved)) {
        context.addIssue({
          code: "custom",
          path: ["factualScore"],
          message: "Factual score must equal 100 * supported / (supported + contradicted).",
        });
      }
    }
  });

// ---------------------------------------------------------------------------
// Run report
// ---------------------------------------------------------------------------

export const stageOutcomeSchema = z.strictObject({
  stage: stageNameSchema,
  status: stageStatusSchema,
  issues: z.array(issueSchema),
  metrics: stageMetricsSchema,
});

export const replayManifestSchema = z.strictObject({
  runId: z.string().min(1),
  versions: engineVersionsSchema,
  seed: nonNegativeIntSchema,
  asOfTime: instantSchema,
  inputHash: contentHashSchema,
  evidenceSetHash: contentHashSchema.nullable(),
  snapshotIds: z.array(z.string().min(1)),
  assessmentIds: z.array(z.string().min(1)),
  budget: runBudgetSchema,
});

export const runCostSummarySchema = z.strictObject({
  externalRequests: nonNegativeIntSchema,
  inputTokens: nonNegativeIntSchema.nullable(),
  outputTokens: nonNegativeIntSchema.nullable(),
  costUsd: z.number().nonnegative().finite().nullable(),
  latencyMs: z.number().nonnegative().finite(),
});

export const runReportSchema = z
  .strictObject({
    schemaVersion: z.literal(CORE_V2_SCHEMA_VERSION),
    contractVersion: z.literal(CORE_V2_CONTRACT_VERSION),
    runId: z.string().min(1),
    createdAt: instantSchema,
    asOfTime: instantSchema,
    engineVersion: z.string().min(1),
    visibility: visibilitySchema,
    status: runStatusSchema,
    stageOutcomes: z.array(stageOutcomeSchema).min(1),
    snapshots: z.array(documentSnapshotSchema),
    primarySnapshotId: z.string().min(1).nullable(),
    claims: z.array(claimSchema),
    candidates: z.array(evidenceCandidateSchema),
    assessments: z.array(evidenceAssessmentSchema),
    provenance: z.array(provenanceGraphSchema),
    decisions: z.array(decisionSchema),
    scorecard: scorecardSchema.nullable(),
    inputCoverage: z.array(inputCoverageSchema),
    unresolvedReasons: z.array(issueSchema),
    evidenceSetHash: contentHashSchema.nullable(),
    replayManifest: replayManifestSchema,
    cost: runCostSummarySchema,
  })
  .superRefine(validateRunReportIntegrity);

/** Legacy stored reports keep v1 decoding and rendering. */
export const legacyRunReportSchema = z.looseObject({
  schemaVersion: z.literal(1),
  checkId: z.string().min(1),
  createdAt: instantSchema,
});

export const versionedRunReportSchema = z.discriminatedUnion("schemaVersion", [
  legacyRunReportSchema,
  runReportSchema,
]);

// ---------------------------------------------------------------------------
// Referential and offset integrity
// ---------------------------------------------------------------------------

function validateRunReportIntegrity(
  report: {
    status: z.infer<typeof runStatusSchema>;
    stageOutcomes: Array<z.infer<typeof stageOutcomeSchema>>;
    snapshots: Array<z.infer<typeof documentSnapshotSchema>>;
    primarySnapshotId: string | null;
    claims: Array<z.infer<typeof claimSchema>>;
    candidates: Array<z.infer<typeof evidenceCandidateSchema>>;
    assessments: Array<z.infer<typeof evidenceAssessmentSchema>>;
    provenance: Array<z.infer<typeof provenanceGraphSchema>>;
    decisions: Array<z.infer<typeof decisionSchema>>;
    scorecard: z.infer<typeof scorecardSchema> | null;
    inputCoverage: Array<z.infer<typeof inputCoverageSchema>>;
    replayManifest: z.infer<typeof replayManifestSchema>;
  },
  context: z.RefinementCtx,
) {
  const snapshots = new Map(report.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const claims = new Map(report.claims.map((claim) => [claim.id, claim]));
  const assessments = new Map(report.assessments.map((assessment) => [assessment.id, assessment]));

  if (report.primarySnapshotId !== null && !snapshots.has(report.primarySnapshotId)) {
    addDangling(context, ["primarySnapshotId"], report.primarySnapshotId);
  }

  for (const [index, claim] of report.claims.entries()) {
    const snapshot = snapshots.get(claim.documentId);
    if (!snapshot) {
      addDangling(context, ["claims", index, "documentId"], claim.documentId);
      continue;
    }
    for (const [spanIndex, span] of claim.spans.entries()) {
      if (span.end > snapshot.normalizedText.length) {
        addIssue(
          context,
          ["claims", index, "spans", spanIndex],
          "Claim span exceeds the snapshot text length.",
        );
      }
    }
    if (claim.parentClaimId !== null && !claims.has(claim.parentClaimId)) {
      addDangling(context, ["claims", index, "parentClaimId"], claim.parentClaimId);
    }
    if (claim.duplicateOfClaimId !== null && !claims.has(claim.duplicateOfClaimId)) {
      addDangling(context, ["claims", index, "duplicateOfClaimId"], claim.duplicateOfClaimId);
    }
  }

  for (const [index, candidate] of report.candidates.entries()) {
    if (!claims.has(candidate.claimId)) {
      addDangling(context, ["candidates", index, "claimId"], candidate.claimId);
    }
  }

  for (const [index, assessment] of report.assessments.entries()) {
    if (!claims.has(assessment.claimId)) {
      addDangling(context, ["assessments", index, "claimId"], assessment.claimId);
    }
    const snapshot = snapshots.get(assessment.snapshotId);
    if (!snapshot) {
      addDangling(context, ["assessments", index, "snapshotId"], assessment.snapshotId);
      continue;
    }
    const { span, quote } = assessment.excerpt;
    if (snapshot.normalizedText.slice(span.start, span.end) !== quote) {
      addIssue(
        context,
        ["assessments", index, "excerpt"],
        "Excerpt offsets do not reproduce the quoted text in the snapshot.",
      );
    }
    for (const [locatorIndex, locator] of assessment.dependenceLocators.entries()) {
      const target = snapshots.get(locator.snapshotId);
      if (!target) {
        addDangling(
          context,
          ["assessments", index, "dependenceLocators", locatorIndex, "snapshotId"],
          locator.snapshotId,
        );
      } else if (
        target.normalizedText.slice(locator.span.start, locator.span.end) !== locator.quote
      ) {
        addIssue(
          context,
          ["assessments", index, "dependenceLocators", locatorIndex],
          "Dependence locator offsets do not reproduce the quoted text.",
        );
      }
    }
  }

  for (const [index, graph] of report.provenance.entries()) {
    if (!claims.has(graph.claimId)) {
      addDangling(context, ["provenance", index, "claimId"], graph.claimId);
    }
    for (const [nodeIndex, node] of graph.nodes.entries()) {
      if (!snapshots.has(node.snapshotId)) {
        addDangling(
          context,
          ["provenance", index, "nodes", nodeIndex, "snapshotId"],
          node.snapshotId,
        );
      }
    }
    for (const [edgeIndex, edge] of graph.edges.entries()) {
      for (const [locatorIndex, locator] of edge.supportingLocators.entries()) {
        const target = snapshots.get(locator.snapshotId);
        if (!target) {
          addDangling(
            context,
            ["provenance", index, "edges", edgeIndex, "supportingLocators", locatorIndex],
            locator.snapshotId,
          );
        } else if (
          target.normalizedText.slice(locator.span.start, locator.span.end) !== locator.quote
        ) {
          addIssue(
            context,
            ["provenance", index, "edges", edgeIndex, "supportingLocators", locatorIndex],
            "Provenance locator offsets do not reproduce the quoted text.",
          );
        }
      }
    }
  }

  const decidedClaims = new Set<string>();
  for (const [index, decision] of report.decisions.entries()) {
    if (!claims.has(decision.claimId)) {
      addDangling(context, ["decisions", index, "claimId"], decision.claimId);
    }
    if (decidedClaims.has(decision.claimId)) {
      addIssue(context, ["decisions", index, "claimId"], "Duplicate decision for one claim.");
    }
    decidedClaims.add(decision.claimId);

    const referenced: Array<[string, string[]]> = [
      ["supportingAssessmentIds", decision.supportingAssessmentIds],
      ["contradictingAssessmentIds", decision.contradictingAssessmentIds],
      ["correctiveContextAssessmentIds", decision.correctiveContextAssessmentIds],
    ];
    for (const [field, ids] of referenced) {
      for (const [idIndex, id] of ids.entries()) {
        const assessment = assessments.get(id);
        if (!assessment) {
          addDangling(context, ["decisions", index, field, idIndex], id);
          continue;
        }
        if (assessment.claimId !== decision.claimId) {
          addIssue(
            context,
            ["decisions", index, field, idIndex],
            "Cited assessment belongs to a different claim.",
          );
        }
        if (assessment.validationStatus !== "validated") {
          addIssue(
            context,
            ["decisions", index, field, idIndex],
            "Only validated assessments may support a decision.",
          );
        }
      }
    }
  }

  for (const [index, coverage] of report.inputCoverage.entries()) {
    if (!snapshots.has(coverage.documentId)) {
      addDangling(context, ["inputCoverage", index, "documentId"], coverage.documentId);
    }
    for (const [segmentIndex, segment] of coverage.segments.entries()) {
      for (const [claimIndex, claimId] of segment.claimIds.entries()) {
        if (!claims.has(claimId)) {
          addDangling(
            context,
            ["inputCoverage", index, "segments", segmentIndex, "claimIds", claimIndex],
            claimId,
          );
        }
      }
    }
  }

  for (const [index, id] of report.replayManifest.snapshotIds.entries()) {
    if (!snapshots.has(id)) {
      addDangling(context, ["replayManifest", "snapshotIds", index], id);
    }
  }
  for (const [index, id] of report.replayManifest.assessmentIds.entries()) {
    if (!assessments.has(id)) {
      addDangling(context, ["replayManifest", "assessmentIds", index], id);
    }
  }

  if (report.status === "canceled" && report.scorecard !== null) {
    addIssue(context, ["scorecard"], "A canceled run cannot publish a scorecard.");
  }
  if (
    report.status === "complete" &&
    report.stageOutcomes.some((outcome) => outcome.status !== "complete")
  ) {
    addIssue(context, ["status"], "A complete run requires every stage outcome to be complete.");
  }
  if (report.scorecard !== null) {
    const publishedCounts = tallyPublishedLabels(report.decisions);
    const { counts } = report.scorecard;
    const mismatch =
      publishedCounts.supported !== counts.supported ||
      publishedCounts.contradicted !== counts.contradicted ||
      publishedCounts.misleading !== counts.misleading ||
      publishedCounts.mixed !== counts.mixed ||
      publishedCounts.unverified !== counts.unverified;
    if (mismatch) {
      addIssue(
        context,
        ["scorecard", "counts"],
        "Scorecard counts must match the published decision labels.",
      );
    }
  }
}

function tallyPublishedLabels(decisions: Array<z.infer<typeof decisionSchema>>) {
  const counts = { supported: 0, contradicted: 0, misleading: 0, mixed: 0, unverified: 0 };
  for (const decision of decisions) counts[decision.publishedLabel] += 1;
  return counts;
}

function nearlyEqual(left: number | null, right: number | null) {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= 1e-9;
}

function addIssue(context: z.RefinementCtx, path: Array<string | number>, message: string) {
  context.addIssue({ code: "custom", path, message });
}

function addDangling(context: z.RefinementCtx, path: Array<string | number>, id: string) {
  addIssue(context, path, `Dangling reference: ${id} is not present in this report.`);
}

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Span = z.infer<typeof spanSchema>;
export type TimeInterval = z.infer<typeof timeIntervalSchema>;
export type StageStatus = z.infer<typeof stageStatusSchema>;
export type StageName = z.infer<typeof stageNameSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type IssueCode = z.infer<typeof issueCodeSchema>;
export type CoreIssue = z.infer<typeof issueSchema>;
export type StageMetrics = z.infer<typeof stageMetricsSchema>;
export type RunContext = z.infer<typeof runContextSchema>;
export type RunBudget = z.infer<typeof runBudgetSchema>;
export type EngineVersions = z.infer<typeof engineVersionsSchema>;
export type CancellationState = z.infer<typeof cancellationStateSchema>;
export type DocumentSnapshot = z.infer<typeof documentSnapshotSchema>;
export type Locator = z.infer<typeof locatorSchema>;
export type TimestampAssertion = z.infer<typeof timestampAssertionSchema>;
export type DiscoveryHint = z.infer<typeof discoveryHintSchema>;
export type ClaimV2 = z.infer<typeof claimSchema>;
export type InputCoverage = z.infer<typeof inputCoverageSchema>;
export type EvidenceCandidate = z.infer<typeof evidenceCandidateSchema>;
export type EvidenceAssessment = z.infer<typeof evidenceAssessmentSchema>;
export type SufficiencyFeedback = z.infer<typeof sufficiencyFeedbackSchema>;
export type ProvenanceGraph = z.infer<typeof provenanceGraphSchema>;
export type ClaimLabel = z.infer<typeof claimLabelSchema>;
export type DecisionReasonCode = z.infer<typeof decisionReasonCodeSchema>;
export type Calibration = z.infer<typeof calibrationSchema>;
export type Challenge = z.infer<typeof challengeSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type PresentationFinding = z.infer<typeof presentationFindingSchema>;
export type Scorecard = z.infer<typeof scorecardSchema>;
export type ScoreNullReason = z.infer<typeof scoreNullReasonSchema>;
export type StageOutcome = z.infer<typeof stageOutcomeSchema>;
export type ReplayManifest = z.infer<typeof replayManifestSchema>;
export type RunCostSummary = z.infer<typeof runCostSummarySchema>;
export type RunReport = z.infer<typeof runReportSchema>;
export type LegacyRunReport = z.infer<typeof legacyRunReportSchema>;
export type VersionedRunReport = z.infer<typeof versionedRunReportSchema>;
export type QueryIntent = z.infer<typeof queryIntentSchema>;
export type EvidenceRelation = z.infer<typeof evidenceRelationSchema>;

// ---------------------------------------------------------------------------
// Canonical examples
//
// These illustrate contract shape only. No calibrator has been fitted and no
// evaluation has been run; the calibration fields below are placeholders that
// demonstrate the in-scope branch, not evidence that a calibrator exists.
// ---------------------------------------------------------------------------

const EXAMPLE_AS_OF = "2026-09-10T00:00:00.000Z";

const EXAMPLE_TEXTS = {
  completeInput: "Aurora Labs opened a plant in Turin in 2024.",
  completeEvidence: "The Turin plant of Aurora Labs began operations in 2024.",
  partialInput:
    "Aurora Labs opened a plant in Turin in 2024. The company also said exports doubled in 2025.",
  ambiguousInput: "They said the figure doubled last year.",
  noClaimInput: "I think the new plant is a wonderful idea.",
} as const;

const EXAMPLE_HASHES = {
  completeInput: "sha256:f3878f1a6066eacd7439ee4c8932d6652888776559768b8c91c9c4724d947083",
  completeEvidence: "sha256:7f9a9cdaa4a1430815186c27c928283ffa51a12b280818e692175e3d7ca50b2e",
  partialInput: "sha256:03561edf9ac07692acd77be815dc543f30c2455363551c8d309243424faad008",
  ambiguousInput: "sha256:b8da8971fdb38769a8f95f5f041961f4989806efa812ceb6cf6d200f8a4a1b78",
  noClaimInput: "sha256:f8324f7eaf1e472a01b1aaca91776a9a19df3f35bfae317d5fc38b9ec63e7ba6",
  emptyInput: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
} as const;

const exampleVersions: EngineVersions = {
  engine: "core-v2.0.0",
  prompt: "core-prompts-2.0.0",
  model: "example-model-id",
  retriever: "core-retriever-2.0.0",
  embedding: { model: "example-embedding-id", dimensions: 1024, preprocessing: "nfkc-lower-1" },
  calibration: null,
};

function exampleMetrics(durationMs: number, externalRequests = 0): StageMetrics {
  return {
    startedAt: EXAMPLE_AS_OF,
    completedAt: EXAMPLE_AS_OF,
    durationMs,
    externalRequests,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
}

function exampleStageOutcomes(
  status: StageStatus,
  issues: CoreIssue[] = [],
  overrides: Partial<Record<StageName, StageStatus>> = {},
): StageOutcome[] {
  return stageNameSchema.options.map((stage) => {
    const stageStatus = overrides[stage] ?? status;
    return {
      stage,
      status: stageStatus,
      issues: stageStatus === "complete" ? [] : issues,
      metrics: exampleMetrics(10),
    };
  });
}

function exampleIssue(code: IssueCode, message: string): CoreIssue {
  return { code, severity: "warning", message, claimId: null, snapshotId: null, url: null };
}

function exampleSnapshot(
  overrides: Partial<DocumentSnapshot> & Pick<DocumentSnapshot, "id">,
): DocumentSnapshot {
  const normalizedText = overrides.normalizedText ?? "";
  return {
    contentHash: EXAMPLE_HASHES.emptyInput,
    rawContentHash: null,
    originalUrl: null,
    finalUrl: null,
    canonicalUrl: null,
    acquiredAt: EXAMPLE_AS_OF,
    mimeType: "text/plain",
    language: "en",
    role: "submitted_input",
    extractionStatus: "complete",
    extractionMethod: "plain_text",
    limits: {
      byteLimit: 5_000_000,
      characterLimit: 200_000,
      bytesRetained: normalizedText.length,
      charactersRetained: normalizedText.length,
      truncated: false,
    },
    locators: [],
    timestampAssertions: [],
    discoveryHints: [],
    blobLocator: { status: "unavailable", uri: null },
    ...overrides,
    normalizedText,
  };
}

function exampleEmptyEvidenceSummary(): z.infer<typeof evidenceSummarySchema> {
  return {
    admittedSnapshots: 0,
    validatedAssessments: 0,
    rejectedAssessments: 0,
    needsHumanReviewAssessments: 0,
    independentOriginGroups: 0,
    unknownDependenceGroups: 0,
  };
}

function exampleEmptyOriginSummary(): z.infer<typeof originSummarySchema> {
  return {
    claimsWithGraphs: 0,
    claimsWithCandidateRoots: 0,
    claimsWithUnresolvedChronology: 0,
    inaccessibleOriginals: 0,
  };
}

function exampleReplayManifest(
  runId: string,
  snapshotIds: string[],
  assessmentIds: string[],
  inputHash: string,
  evidenceSetHash: string | null,
): ReplayManifest {
  return {
    runId,
    versions: exampleVersions,
    seed: 20_260_910,
    asOfTime: EXAMPLE_AS_OF,
    inputHash,
    evidenceSetHash,
    snapshotIds,
    assessmentIds,
    budget: CORE_V2_EVALUATION_BUDGET,
  };
}

function exampleCost(externalRequests = 0): RunCostSummary {
  return {
    externalRequests,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    latencyMs: 1200,
  };
}

export const runContextExample: RunContext = {
  runId: "run_example_complete",
  tenantId: "tenant_example",
  ownerUserId: "user_example",
  visibility: "private",
  inputHash: EXAMPLE_HASHES.completeInput,
  asOfTime: EXAMPLE_AS_OF,
  versions: exampleVersions,
  executionMode: "fixture",
  budget: CORE_V2_EVALUATION_BUDGET,
  cancellation: { requested: false, requestedAt: null, reason: null },
  auditSinkId: "audit_example",
};

/** Every stage complete, one resolved claim, publishable decision and score. */
export const completeRunReportExample: RunReport = {
  schemaVersion: CORE_V2_SCHEMA_VERSION,
  contractVersion: CORE_V2_CONTRACT_VERSION,
  runId: "run_example_complete",
  createdAt: EXAMPLE_AS_OF,
  asOfTime: EXAMPLE_AS_OF,
  engineVersion: exampleVersions.engine,
  visibility: "private",
  status: "complete",
  stageOutcomes: exampleStageOutcomes("complete"),
  snapshots: [
    exampleSnapshot({
      id: "snap_input_complete",
      contentHash: EXAMPLE_HASHES.completeInput,
      normalizedText: EXAMPLE_TEXTS.completeInput,
      locators: [
        {
          id: "loc_input_p1",
          kind: "paragraph",
          path: "/article/p[1]",
          span: { start: 0, end: EXAMPLE_TEXTS.completeInput.length },
          boundingBox: null,
          transcriptionUncertain: false,
        },
      ],
    }),
    exampleSnapshot({
      id: "snap_evidence_complete",
      role: "evidence",
      contentHash: EXAMPLE_HASHES.completeEvidence,
      normalizedText: EXAMPLE_TEXTS.completeEvidence,
      originalUrl: "https://records.example.org/turin-plant",
      finalUrl: "https://records.example.org/turin-plant",
      canonicalUrl: "https://records.example.org/turin-plant",
      extractionMethod: "structured_html",
      mimeType: "text/html",
      timestampAssertions: [
        {
          type: "published",
          interval: {
            earliest: "2024-06-01T00:00:00.000Z",
            latest: "2024-06-01T00:00:00.000Z",
            precision: "day",
            timezone: "UTC",
          },
          source: "structured_data",
          locatorId: null,
        },
      ],
      blobLocator: { status: "stored", uri: "snapshot://snap_evidence_complete" },
    }),
  ],
  primarySnapshotId: "snap_input_complete",
  claims: [
    {
      id: "claim_complete_1",
      documentId: "snap_input_complete",
      text: "Aurora Labs opened a plant in Turin in 2024.",
      spans: [{ start: 0, end: EXAMPLE_TEXTS.completeInput.length }],
      occurrenceSpans: [],
      retrievalText: "Aurora Labs Turin plant opening 2024",
      proposition: {
        subject: "Aurora Labs",
        predicate: "opened a plant in",
        object: "Turin",
        qualifiers: ["in 2024"],
      },
      attribution: { kind: "direct_assertion", attributedTo: null, attributionSpan: null },
      negated: false,
      quantities: [],
      time: {
        statedText: "2024",
        interval: {
          earliest: "2024-01-01T00:00:00.000Z",
          latest: "2024-12-31T23:59:59.000Z",
          precision: "year",
          timezone: null,
        },
      },
      place: "Turin",
      unresolvedContext: [],
      checkability: "checkable",
      material: true,
      parentClaimId: null,
      duplicateOfClaimId: null,
      coverageDisposition: "factual_claim",
    },
  ],
  candidates: [
    {
      id: "cand_complete_1",
      claimId: "claim_complete_1",
      query: "Aurora Labs Turin plant 2024",
      queryIntent: "neutral",
      provider: "example-search",
      rank: 1,
      discoveredAt: EXAMPLE_AS_OF,
      proposedUrl: "https://records.example.org/turin-plant",
      title: "Turin plant record",
      snippet: "The Turin plant of Aurora Labs began operations in 2024.",
      providerRating: null,
      admissible: false,
    },
  ],
  assessments: [
    {
      id: "assess_complete_1",
      claimId: "claim_complete_1",
      snapshotId: "snap_evidence_complete",
      excerpt: {
        span: { start: 0, end: EXAMPLE_TEXTS.completeEvidence.length },
        quote: EXAMPLE_TEXTS.completeEvidence,
        locatorId: null,
      },
      relation: "supports",
      applicability: {
        temporal: "applicable",
        entity: "applicable",
        jurisdiction: "applicable",
        scope: "applicable",
      },
      directness: "primary",
      dependencyGroupId: "origin_group_turin_plant",
      dependence: "independent",
      dependenceLocators: [],
      method: {
        name: "entailment-v2",
        model: "example-model-id",
        promptVersion: "core-prompts-2.0.0",
        engineVersion: "core-v2.0.0",
      },
      checks: [
        { check: "quote_offsets", result: "pass", detail: "Offsets reproduce the quoted text." },
        {
          check: "entity_identity",
          result: "pass",
          detail: "Aurora Labs matches the claim subject.",
        },
        { check: "temporal_scope", result: "pass", detail: "Both refer to 2024." },
      ],
      calculation: null,
      validationStatus: "validated",
      justification: "The record states the plant began operations in 2024.",
    },
  ],
  provenance: [
    {
      claimId: "claim_complete_1",
      nodes: [
        {
          snapshotId: "snap_evidence_complete",
          role: "primary_record",
          url: "https://records.example.org/turin-plant",
          timestamps: [
            {
              type: "published",
              interval: {
                earliest: "2024-06-01T00:00:00.000Z",
                latest: "2024-06-01T00:00:00.000Z",
                precision: "day",
                timezone: "UTC",
              },
              source: "structured_data",
              locatorId: null,
            },
          ],
          claimPresentInContent: true,
        },
      ],
      edges: [],
      candidateRoots: [
        {
          snapshotId: "snap_evidence_complete",
          rootKind: "primary_record",
          rank: 1,
          signals: ["Official register entry", "Earliest observed statement in the searched range"],
        },
      ],
      searchLog: [
        {
          query: "Aurora Labs Turin plant 2024",
          provider: "example-search",
          executedAt: EXAMPLE_AS_OF,
          resultCount: 1,
          outcome: "results",
        },
      ],
      searchedDateRange: {
        earliest: "2024-01-01T00:00:00.000Z",
        latest: EXAMPLE_AS_OF,
        precision: "day",
        timezone: "UTC",
      },
      hopsUsed: 1,
      chronologyConflicts: [],
      cycles: [],
      inaccessibleOriginals: [],
      coverageStatus: "complete",
      globalOriginClaimed: false,
    },
  ],
  decisions: [
    {
      claimId: "claim_complete_1",
      diagnosticLabel: "supported",
      publishedLabel: "supported",
      reasonCodes: ["supported_by_admissible_evidence"],
      supportingAssessmentIds: ["assess_complete_1"],
      contradictingAssessmentIds: [],
      correctiveContextAssessmentIds: [],
      justification: "An acquired primary record entails the scoped assertion.",
      challenge: {
        status: "resolved",
        independentLabel: "supported",
        agreed: true,
        targetedRoundsUsed: 0,
        notes: "The independent reassessment agreed without seeing the draft label.",
      },
      calibration: {
        applicability: "in_scope",
        calibratedCorrectness: 0.94,
        calibratorVersion: "example-calibrator-0",
        sliceId: "en/business/2026",
      },
      rawModelConfidence: 0.88,
      citationIntegrity: "valid",
    },
  ],
  scorecard: {
    formulaVersion: CORE_V2_SCORE_FORMULA_VERSION,
    factualScore: 100,
    nullReasons: [],
    counts: {
      supported: 1,
      contradicted: 0,
      misleading: 0,
      mixed: 0,
      unverified: 0,
      eligibleFactualClaims: 1,
      deferredClaims: 0,
      omittedClaims: 0,
    },
    resolutionCoverage: 1,
    extractionCoverage: 1,
    inputStatus: "complete",
    extractionStatus: "complete",
    materialMixedOrMisleadingOpen: false,
    evidence: {
      admittedSnapshots: 1,
      validatedAssessments: 1,
      rejectedAssessments: 0,
      needsHumanReviewAssessments: 0,
      independentOriginGroups: 1,
      unknownDependenceGroups: 0,
    },
    origin: {
      claimsWithGraphs: 1,
      claimsWithCandidateRoots: 1,
      claimsWithUnresolvedChronology: 0,
      inaccessibleOriginals: 0,
    },
    presentationFindings: [],
  },
  inputCoverage: [
    {
      documentId: "snap_input_complete",
      segments: [
        {
          span: { start: 0, end: EXAMPLE_TEXTS.completeInput.length },
          disposition: "factual_claim",
          claimIds: ["claim_complete_1"],
          reason: null,
        },
      ],
      charactersCovered: EXAMPLE_TEXTS.completeInput.length,
      charactersTotal: EXAMPLE_TEXTS.completeInput.length,
      extractionStatus: "complete",
    },
  ],
  unresolvedReasons: [],
  evidenceSetHash: EXAMPLE_HASHES.completeEvidence,
  replayManifest: exampleReplayManifest(
    "run_example_complete",
    ["snap_input_complete", "snap_evidence_complete"],
    ["assess_complete_1"],
    EXAMPLE_HASHES.completeInput,
    EXAMPLE_HASHES.completeEvidence,
  ),
  cost: exampleCost(2),
};

/** Truncated input with one deferred claim: the score is gated to null. */
export const partialRunReportExample: RunReport = {
  ...completeRunReportExample,
  runId: "run_example_partial",
  status: "partial",
  stageOutcomes: exampleStageOutcomes(
    "complete",
    [exampleIssue("truncation", "Input exceeded the character limit and was chunked.")],
    { normalize_input: "partial", extract_claims: "partial" },
  ),
  snapshots: [
    exampleSnapshot({
      id: "snap_input_complete",
      contentHash: EXAMPLE_HASHES.partialInput,
      normalizedText: EXAMPLE_TEXTS.partialInput,
      extractionStatus: "partial",
      limits: {
        byteLimit: 5_000_000,
        characterLimit: 44,
        bytesRetained: EXAMPLE_TEXTS.partialInput.length,
        charactersRetained: EXAMPLE_TEXTS.partialInput.length,
        truncated: true,
      },
    }),
    ...completeRunReportExample.snapshots.slice(1),
  ],
  claims: [
    ...completeRunReportExample.claims,
    {
      id: "claim_partial_deferred",
      documentId: "snap_input_complete",
      text: "The company also said exports doubled in 2025.",
      spans: [{ start: 45, end: EXAMPLE_TEXTS.partialInput.length }],
      occurrenceSpans: [],
      retrievalText: "Aurora Labs exports doubled 2025",
      proposition: {
        subject: "Aurora Labs",
        predicate: "said exports doubled",
        object: null,
        qualifiers: ["in 2025"],
      },
      attribution: {
        kind: "attributed_statement",
        attributedTo: "Aurora Labs",
        attributionSpan: { start: 45, end: 66 },
      },
      negated: false,
      quantities: [
        {
          rawText: "doubled",
          value: 2,
          unit: null,
          denominatorText: null,
          kind: "rate",
        },
      ],
      time: {
        statedText: "2025",
        interval: {
          earliest: "2025-01-01T00:00:00.000Z",
          latest: "2025-12-31T23:59:59.000Z",
          precision: "year",
          timezone: null,
        },
      },
      place: null,
      unresolvedContext: [],
      checkability: "checkable",
      material: true,
      parentClaimId: null,
      duplicateOfClaimId: null,
      coverageDisposition: "deferred",
    },
  ],
  scorecard: {
    ...completeRunReportExample.scorecard!,
    factualScore: null,
    nullReasons: ["partial_input", "partial_extraction"],
    counts: {
      ...completeRunReportExample.scorecard!.counts,
      deferredClaims: 1,
    },
    extractionCoverage: 0.5,
    inputStatus: "partial",
    extractionStatus: "partial",
  },
  inputCoverage: [
    {
      documentId: "snap_input_complete",
      segments: [
        {
          span: { start: 0, end: 44 },
          disposition: "factual_claim",
          claimIds: ["claim_complete_1"],
          reason: null,
        },
        {
          span: { start: 45, end: EXAMPLE_TEXTS.partialInput.length },
          disposition: "deferred",
          claimIds: ["claim_partial_deferred"],
          reason: "The run budget was exhausted before this claim was retrieved.",
        },
      ],
      charactersCovered: EXAMPLE_TEXTS.partialInput.length,
      charactersTotal: EXAMPLE_TEXTS.partialInput.length,
      extractionStatus: "partial",
    },
  ],
  unresolvedReasons: [
    exampleIssue(
      "deferred_processing",
      "One inventoried claim was not analyzed within the budget.",
    ),
  ],
  replayManifest: exampleReplayManifest(
    "run_example_partial",
    ["snap_input_complete", "snap_evidence_complete"],
    ["assess_complete_1"],
    EXAMPLE_HASHES.partialInput,
    EXAMPLE_HASHES.completeEvidence,
  ),
};

/** The submitted link could not be read. A slug stays a discovery hint. */
export const unavailableRunReportExample: RunReport = {
  schemaVersion: CORE_V2_SCHEMA_VERSION,
  contractVersion: CORE_V2_CONTRACT_VERSION,
  runId: "run_example_unavailable",
  createdAt: EXAMPLE_AS_OF,
  asOfTime: EXAMPLE_AS_OF,
  engineVersion: exampleVersions.engine,
  visibility: "private",
  status: "unavailable",
  stageOutcomes: exampleStageOutcomes("unavailable", [
    exampleIssue("content_unavailable", "The publisher returned an anti-bot interstitial."),
  ]),
  snapshots: [
    exampleSnapshot({
      id: "snap_input_unavailable",
      contentHash: EXAMPLE_HASHES.emptyInput,
      normalizedText: "",
      originalUrl: "https://news.example.com/aurora-labs-turin-plant",
      finalUrl: "https://news.example.com/aurora-labs-turin-plant",
      mimeType: "text/html",
      extractionStatus: "blocked",
      extractionMethod: "none",
      discoveryHints: [{ kind: "url_slug", text: "aurora-labs-turin-plant" }],
    }),
  ],
  primarySnapshotId: "snap_input_unavailable",
  claims: [],
  candidates: [],
  assessments: [],
  provenance: [],
  decisions: [],
  scorecard: null,
  inputCoverage: [
    {
      documentId: "snap_input_unavailable",
      segments: [],
      charactersCovered: 0,
      charactersTotal: 0,
      extractionStatus: "unavailable",
    },
  ],
  unresolvedReasons: [
    exampleIssue("blocked_page", "The original content was never acquired, so nothing was scored."),
  ],
  evidenceSetHash: null,
  replayManifest: exampleReplayManifest(
    "run_example_unavailable",
    ["snap_input_unavailable"],
    [],
    EXAMPLE_HASHES.emptyInput,
    null,
  ),
  cost: exampleCost(1),
};

/** An unresolvable pronoun and referent keep the claim out of scope. */
export const ambiguousRunReportExample: RunReport = {
  schemaVersion: CORE_V2_SCHEMA_VERSION,
  contractVersion: CORE_V2_CONTRACT_VERSION,
  runId: "run_example_ambiguous",
  createdAt: EXAMPLE_AS_OF,
  asOfTime: EXAMPLE_AS_OF,
  engineVersion: exampleVersions.engine,
  visibility: "private",
  status: "partial",
  stageOutcomes: exampleStageOutcomes(
    "complete",
    [exampleIssue("ambiguous_input", "The claim subject and referent are unresolved.")],
    { retrieve_evidence: "partial", assess_evidence: "partial" },
  ),
  snapshots: [
    exampleSnapshot({
      id: "snap_input_ambiguous",
      contentHash: EXAMPLE_HASHES.ambiguousInput,
      normalizedText: EXAMPLE_TEXTS.ambiguousInput,
    }),
  ],
  primarySnapshotId: "snap_input_ambiguous",
  claims: [
    {
      id: "claim_ambiguous_1",
      documentId: "snap_input_ambiguous",
      text: "They said the figure doubled last year.",
      spans: [{ start: 0, end: EXAMPLE_TEXTS.ambiguousInput.length }],
      occurrenceSpans: [],
      retrievalText: "unspecified figure doubled last year",
      proposition: {
        subject: "They",
        predicate: "said the figure doubled",
        object: null,
        qualifiers: ["last year"],
      },
      attribution: {
        kind: "attributed_statement",
        attributedTo: null,
        attributionSpan: { start: 0, end: 9 },
      },
      negated: false,
      quantities: [
        { rawText: "doubled", value: 2, unit: null, denominatorText: null, kind: "rate" },
      ],
      time: {
        statedText: "last year",
        interval: { earliest: null, latest: null, precision: null, timezone: null },
      },
      place: null,
      unresolvedContext: [
        "The pronoun 'They' has no antecedent in the submitted text.",
        "'the figure' names no measurable quantity.",
      ],
      checkability: "needs_context",
      material: true,
      parentClaimId: null,
      duplicateOfClaimId: null,
      coverageDisposition: "factual_claim",
    },
  ],
  candidates: [],
  assessments: [],
  provenance: [],
  decisions: [
    {
      claimId: "claim_ambiguous_1",
      diagnosticLabel: "unverified",
      publishedLabel: "unverified",
      reasonCodes: ["ambiguous_claim_scope", "unresolved_context"],
      supportingAssessmentIds: [],
      contradictingAssessmentIds: [],
      correctiveContextAssessmentIds: [],
      justification:
        "The proposition has no resolvable subject or quantity, so it is not checkable.",
      challenge: {
        status: "not_required",
        independentLabel: null,
        agreed: null,
        targetedRoundsUsed: 0,
        notes: "No decisive verdict was proposed.",
      },
      calibration: {
        applicability: "out_of_scope",
        calibratedCorrectness: null,
        calibratorVersion: null,
        reason: "Ambiguous claims are outside every validated calibration slice.",
      },
      rawModelConfidence: null,
      citationIntegrity: "not_checked",
    },
  ],
  scorecard: {
    formulaVersion: CORE_V2_SCORE_FORMULA_VERSION,
    factualScore: null,
    nullReasons: ["zero_resolved_denominator", "resolution_coverage_below_threshold"],
    counts: {
      supported: 0,
      contradicted: 0,
      misleading: 0,
      mixed: 0,
      unverified: 1,
      eligibleFactualClaims: 1,
      deferredClaims: 0,
      omittedClaims: 0,
    },
    resolutionCoverage: 0,
    extractionCoverage: 1,
    inputStatus: "complete",
    extractionStatus: "complete",
    materialMixedOrMisleadingOpen: false,
    evidence: exampleEmptyEvidenceSummary(),
    origin: exampleEmptyOriginSummary(),
    presentationFindings: [],
  },
  inputCoverage: [
    {
      documentId: "snap_input_ambiguous",
      segments: [
        {
          span: { start: 0, end: EXAMPLE_TEXTS.ambiguousInput.length },
          disposition: "factual_claim",
          claimIds: ["claim_ambiguous_1"],
          reason: null,
        },
      ],
      charactersCovered: EXAMPLE_TEXTS.ambiguousInput.length,
      charactersTotal: EXAMPLE_TEXTS.ambiguousInput.length,
      extractionStatus: "complete",
    },
  ],
  unresolvedReasons: [
    exampleIssue("ambiguous_input", "The claim could not be scoped well enough to search."),
  ],
  evidenceSetHash: null,
  replayManifest: exampleReplayManifest(
    "run_example_ambiguous",
    ["snap_input_ambiguous"],
    [],
    EXAMPLE_HASHES.ambiguousInput,
    null,
  ),
  cost: exampleCost(0),
};

/** Cancellation is a terminal run state of its own and never scores. */
export const canceledRunReportExample: RunReport = {
  schemaVersion: CORE_V2_SCHEMA_VERSION,
  contractVersion: CORE_V2_CONTRACT_VERSION,
  runId: "run_example_canceled",
  createdAt: EXAMPLE_AS_OF,
  asOfTime: EXAMPLE_AS_OF,
  engineVersion: exampleVersions.engine,
  visibility: "private",
  status: "canceled",
  stageOutcomes: exampleStageOutcomes(
    "failed",
    [exampleIssue("cancellation_requested", "The owner canceled the run.")],
    { normalize_input: "complete" },
  ),
  snapshots: [
    exampleSnapshot({
      id: "snap_input_canceled",
      contentHash: EXAMPLE_HASHES.completeInput,
      normalizedText: EXAMPLE_TEXTS.completeInput,
    }),
  ],
  primarySnapshotId: "snap_input_canceled",
  claims: [],
  candidates: [],
  assessments: [],
  provenance: [],
  decisions: [],
  scorecard: null,
  inputCoverage: [],
  unresolvedReasons: [
    exampleIssue("cancellation_requested", "Leases and spend reservations were released."),
  ],
  evidenceSetHash: null,
  replayManifest: exampleReplayManifest(
    "run_example_canceled",
    ["snap_input_canceled"],
    [],
    EXAMPLE_HASHES.completeInput,
    null,
  ),
  cost: exampleCost(0),
};

/** Opinion-only input: no checkable claims, never a zero accuracy score. */
export const noClaimRunReportExample: RunReport = {
  schemaVersion: CORE_V2_SCHEMA_VERSION,
  contractVersion: CORE_V2_CONTRACT_VERSION,
  runId: "run_example_no_claim",
  createdAt: EXAMPLE_AS_OF,
  asOfTime: EXAMPLE_AS_OF,
  engineVersion: exampleVersions.engine,
  visibility: "private",
  status: "complete",
  stageOutcomes: exampleStageOutcomes("complete"),
  snapshots: [
    exampleSnapshot({
      id: "snap_input_no_claim",
      contentHash: EXAMPLE_HASHES.noClaimInput,
      normalizedText: EXAMPLE_TEXTS.noClaimInput,
    }),
  ],
  primarySnapshotId: "snap_input_no_claim",
  claims: [
    {
      id: "claim_no_claim_1",
      documentId: "snap_input_no_claim",
      text: "The new plant is a wonderful idea.",
      spans: [{ start: 0, end: EXAMPLE_TEXTS.noClaimInput.length }],
      occurrenceSpans: [],
      retrievalText: "new plant wonderful idea",
      proposition: {
        subject: "the new plant",
        predicate: "is",
        object: "a wonderful idea",
        qualifiers: [],
      },
      attribution: { kind: "direct_assertion", attributedTo: null, attributionSpan: null },
      negated: false,
      quantities: [],
      time: {
        statedText: null,
        interval: { earliest: null, latest: null, precision: null, timezone: null },
      },
      place: null,
      unresolvedContext: [],
      checkability: "not_checkable",
      material: false,
      parentClaimId: null,
      duplicateOfClaimId: null,
      coverageDisposition: "opinion",
    },
  ],
  candidates: [],
  assessments: [],
  provenance: [],
  decisions: [],
  scorecard: {
    formulaVersion: CORE_V2_SCORE_FORMULA_VERSION,
    factualScore: null,
    nullReasons: ["no_checkable_claims", "zero_resolved_denominator"],
    counts: {
      supported: 0,
      contradicted: 0,
      misleading: 0,
      mixed: 0,
      unverified: 0,
      eligibleFactualClaims: 0,
      deferredClaims: 0,
      omittedClaims: 0,
    },
    resolutionCoverage: null,
    extractionCoverage: 1,
    inputStatus: "complete",
    extractionStatus: "complete",
    materialMixedOrMisleadingOpen: false,
    evidence: exampleEmptyEvidenceSummary(),
    origin: exampleEmptyOriginSummary(),
    presentationFindings: [],
  },
  inputCoverage: [
    {
      documentId: "snap_input_no_claim",
      segments: [
        {
          span: { start: 0, end: EXAMPLE_TEXTS.noClaimInput.length },
          disposition: "opinion",
          claimIds: ["claim_no_claim_1"],
          reason: "The sentence states a preference, not a checkable proposition.",
        },
      ],
      charactersCovered: EXAMPLE_TEXTS.noClaimInput.length,
      charactersTotal: EXAMPLE_TEXTS.noClaimInput.length,
      extractionStatus: "complete",
    },
  ],
  unresolvedReasons: [],
  evidenceSetHash: null,
  replayManifest: exampleReplayManifest(
    "run_example_no_claim",
    ["snap_input_no_claim"],
    [],
    EXAMPLE_HASHES.noClaimInput,
    null,
  ),
  cost: exampleCost(0),
};

/** Saved v1 reports keep rendering through the legacy branch. */
export const legacyRunReportExample: LegacyRunReport = {
  schemaVersion: 1,
  checkId: "chk_legacy_0001",
  createdAt: "2026-02-14T10:00:00.000Z",
  headline: "Aurora Labs plant claim",
  traceraScore: { overall: 72 },
};

export const coreV2Examples = {
  complete: completeRunReportExample,
  partial: partialRunReportExample,
  unavailable: unavailableRunReportExample,
  ambiguous: ambiguousRunReportExample,
  canceled: canceledRunReportExample,
  noClaim: noClaimRunReportExample,
  legacy: legacyRunReportExample,
} as const;
