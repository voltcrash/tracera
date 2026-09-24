import assert from "node:assert/strict";
import {
  coreV2Examples,
  decisionSchema,
  focusedSelectionSchema,
  inputCoverageSchema,
  type ClaimLabel,
  type ClaimV2,
  type DocumentSnapshot,
  type EvidenceAssessment,
} from "@repo/contracts/core-v2";
import {
  buildImmutableTimeline,
  projectReport,
  publishFocusedDecisions,
  scoreReportV2,
  selectTopClaims,
} from "../../src/core/index.js";
import { buildPresentationFindings } from "../../src/core/framing/index.js";
import { createDocumentAcquisitionPort } from "../../src/core/ingestion/index.js";
import { createTraceOriginsV2, rankRoots } from "../../src/core/provenance/index.js";
import { scoringAssessment, scoringClaim, scoringDecision } from "./scoring-scenarios.js";
import {
  createProvenanceEnvironment,
  provenanceAssessment,
  provenanceClaim,
  provenanceSnapshot,
  scriptedProvenanceRetrieval,
} from "./scripted-provenance.js";
import { evidenceSnapshot } from "./scripted-evidence.js";

export const FOCUSED_SCENARIOS = [
  "focused-empty-selection-is-null",
  "focused-ratio-and-counts",
  "focused-unverified-is-not-fractional",
  "focused-omitted-work-is-explicit",
  "focused-partial-input-is-null",
  "focused-conflict-is-null",
  "focused-misleading-is-not-resolution",
  "focused-citation-validation-is-null",
  "provenance-is-scoped-and-dependent",
  "framing-is-presentation-only",
  "image-uncertainty-is-explicit",
  "timeline-uses-immutable-observations",
] as const;

export type FocusedScenario = (typeof FOCUSED_SCENARIOS)[number];

const AT = "2026-09-10T00:00:00.000Z";
const EMPTY_INTERVAL = {
  earliest: null,
  latest: null,
  precision: null,
  timezone: null,
} as const;

type FocusedRun = ReturnType<typeof makeFocusedRun>;

export async function runFocusedScenario(id: FocusedScenario) {
  switch (id) {
    case "focused-empty-selection-is-null": {
      const result = scoreFocused(makeFocusedRun(["unverified"], [], [0]));
      assert.equal(result.data!.scorecard.selectedClaimCount, 0);
      assert.equal(result.data!.scorecard.resolvedClaimCount, 0);
      assert.equal(result.data!.scorecard.factualScore, null);
      assert.deepEqual(result.data!.scorecard.nullReasons, [
        "no_checkable_claims",
        "zero_resolved_denominator",
      ]);
      return;
    }
    case "focused-ratio-and-counts": {
      const run = makeFocusedRun(["supported", "supported", "contradicted"]);
      const result = scoreFocused(run);
      assert.equal(result.status, "complete");
      assert.equal(result.data!.scorecard.selectedClaimCount, 3);
      assert.equal(result.data!.scorecard.resolvedClaimCount, 3);
      assert.equal(result.data!.scorecard.factualScore, (100 * 2) / 3);
      assert.deepEqual(result.data!.scorecard.counts, {
        supported: 2,
        contradicted: 1,
        mixed: 0,
        misleading: 0,
        unverified: 0,
        eligibleFactualClaims: 3,
        deferredClaims: 0,
        omittedClaims: 0,
      });
      assert.equal(result.data!.scorecard.resolutionCoverage, 1);
      assert.deepEqual(result.data!.scorecard.nullReasons, []);
      return;
    }
    case "focused-unverified-is-not-fractional": {
      const run = makeFocusedRun(["supported", "supported", "unverified"]);
      const result = scoreFocused(run);
      assert.equal(result.data!.scorecard.factualScore, null);
      assert.equal(result.data!.scorecard.resolvedClaimCount, 2);
      assert.equal(result.data!.scorecard.counts.unverified, 1);
      assert.equal(result.data!.scorecard.resolutionCoverage, 2 / 3);
      assert.ok(result.data!.scorecard.nullReasons.includes("resolution_coverage_below_threshold"));
      assert.equal(result.data!.scorecard.factualScore, null);
      return;
    }
    case "focused-omitted-work-is-explicit": {
      const run = makeFocusedRun(["supported", "supported", "contradicted", "unverified"], [2]);
      const result = scoreFocused(run);
      assert.equal(result.data!.scorecard.selectedClaimCount, 3);
      assert.equal(result.data!.scorecard.counts.deferredClaims, 1);
      assert.equal(result.data!.scorecard.counts.omittedClaims, 1);
      assert.equal(result.data!.scorecard.counts.unverified, 0);
      assert.equal(result.data!.scorecard.resolvedClaimCount, 2);
      assert.equal(result.data!.scorecard.factualScore, null);
      assert.ok(result.data!.scorecard.nullReasons.includes("zero_resolved_denominator") === false);
      return;
    }
    case "focused-partial-input-is-null": {
      const run = makeFocusedRun(["supported", "supported", "supported"]);
      const result = scoreFocused(run, { inputStatus: "partial", extractionStatus: "partial" });
      assert.equal(result.data!.scorecard.factualScore, null);
      assert.ok(result.data!.scorecard.nullReasons.includes("partial_input"));
      assert.ok(result.data!.scorecard.nullReasons.includes("partial_extraction"));

      const partialSelection = focusedSelectionSchema.parse({
        ...run.selection,
        coverage: { ...run.selection.coverage, partialDocuments: 1, omittedCharacters: 1 },
      });
      const partialCoverage = scoreFocused({ ...run, selection: partialSelection });
      assert.equal(partialCoverage.data!.scorecard.factualScore, null);
      assert.ok(partialCoverage.data!.scorecard.nullReasons.includes("partial_extraction"));
      return;
    }
    case "focused-conflict-is-null": {
      const run = makeFocusedRun(["mixed"]);
      const result = scoreFocused(run);
      assert.equal(result.data!.scorecard.counts.mixed, 1);
      assert.equal(result.data!.scorecard.resolvedClaimCount, 0);
      assert.equal(result.data!.scorecard.factualScore, null);
      assert.ok(result.data!.scorecard.nullReasons.includes("unresolved_conflict"));
      assert.ok(result.data!.scorecard.nullReasons.includes("material_mixed_or_misleading_open"));
      return;
    }
    case "focused-misleading-is-not-resolution": {
      const result = scoreFocused(makeFocusedRun(["misleading"]));
      assert.equal(result.data!.scorecard.counts.misleading, 1);
      assert.equal(result.data!.scorecard.resolvedClaimCount, 0);
      assert.equal(result.data!.scorecard.factualScore, null);
      assert.ok(result.data!.scorecard.nullReasons.includes("zero_resolved_denominator"));
      assert.ok(result.data!.scorecard.nullReasons.includes("material_mixed_or_misleading_open"));
      return;
    }
    case "focused-citation-validation-is-null": {
      const run = makeFocusedRun(["unverified"]);
      const original = run.decisions[0]!;
      const invalid = decisionSchema.parse({
        ...original,
        reasonCodes: [...original.reasonCodes, "citation_validation_failed"],
        citationIntegrity: "invalid",
        focusedPublication: {
          ...original.focusedPublication!,
          status: "abstained",
          gate: "invalid_citation",
        },
      });
      const result = scoreFocused({ ...run, decisions: [invalid] });
      assert.equal(result.data!.scorecard.factualScore, null);
      assert.ok(result.data!.scorecard.nullReasons.includes("citation_validation_failed"));

      const withoutSnapshots = scoreFocused({ ...run, snapshots: [] });
      assert.equal(withoutSnapshots.status, "complete");
      assert.equal(withoutSnapshots.data!.scorecard.factualScore, null);
      assert.ok(
        withoutSnapshots.data!.scorecard.nullReasons.includes("citation_validation_failed"),
      );

      const supported = makeFocusedRun(["supported"]);
      const uncited = {
        ...supported.decisions[0]!,
        supportingAssessmentIds: [],
      };
      const uncitedResult = scoreFocused({ ...supported, decisions: [uncited] });
      assert.equal(uncitedResult.status, "failed");
      assert.equal(uncitedResult.data, null);
      assert.equal(uncitedResult.issues[0]!.code, "citation_validation_failed");
      return;
    }
    case "provenance-is-scoped-and-dependent": {
      const timestamp = {
        type: "published" as const,
        interval: {
          earliest: "2020-01-01T00:00:00.000Z",
          latest: "2020-01-01T00:00:00.000Z",
          precision: "day" as const,
          timezone: "UTC",
        },
        source: "structured_data" as const,
        locatorId: null,
      };
      const first = provenanceSnapshot("focused_origin_a", "https://a.example/report", "", [
        timestamp,
      ]);
      const copy = provenanceSnapshot("focused_origin_b", "https://b.example/report", "", [
        timestamp,
      ]);
      const dependence = {
        dependencyGroupId: "focused_wire",
        dependence: "syndicated_copy" as const,
        dependenceLocators: [
          {
            snapshotId: first.id,
            span: { start: 0, end: provenanceClaim().text.length },
            quote: provenanceClaim().text,
          },
        ],
      };
      const roots = rankRoots(
        [
          {
            snapshotId: first.id,
            role: "report",
            url: first.canonicalUrl,
            timestamps: first.timestampAssertions,
            claimPresentInContent: true,
          },
          {
            snapshotId: copy.id,
            role: "syndication",
            url: copy.canonicalUrl,
            timestamps: copy.timestampAssertions,
            claimPresentInContent: true,
          },
        ],
        [provenanceAssessment(first, dependence), provenanceAssessment(copy, dependence)],
        [first, copy],
      );
      assert.equal(
        roots.filter(({ rootKind }) => rootKind === "earliest_observed_statement").length,
        2,
      );
      assert.ok(
        roots
          .filter(({ rootKind }) => rootKind === "earliest_observed_statement")
          .every(({ signals }) =>
            signals.some((signal) => signal === "Earliest observed within the searched scope."),
          ),
      );
      assert.equal(
        new Set(
          [provenanceAssessment(first, dependence), provenanceAssessment(copy, dependence)]
            .filter(({ dependence: value }) => value === "independent")
            .map(({ dependencyGroupId }) => dependencyGroupId),
        ).size,
        0,
      );

      const inaccessibleUrl = "https://missing.example/original";
      const source = provenanceSnapshot(
        "focused_inaccessible",
        "https://report.example/story",
        ` Cites ${inaccessibleUrl}`,
      );
      const fixture = createProvenanceEnvironment();
      const traced = await createTraceOriginsV2({
        retrieval: scriptedProvenanceRetrieval(new Map()),
      })(
        {
          claims: [provenanceClaim()],
          snapshots: [source],
          assessments: [provenanceAssessment(source)],
        },
        fixture.environment,
      );
      assert.equal(traced.data!.graphs[0]!.coverageStatus, "partial");
      assert.deepEqual(traced.data!.graphs[0]!.inaccessibleOriginals, [
        { url: inaccessibleUrl, reason: "content_unavailable" },
      ]);

      const view = projectReport({
        ...coreV2Examples.complete,
        provenance: [
          {
            ...coreV2Examples.complete.provenance[0]!,
            coverageStatus: "partial",
            inaccessibleOriginals: [
              { url: inaccessibleUrl, reason: "content_unavailable" as const },
            ],
          },
        ],
      });
      assert.equal(view.schemaVersion, 2);
      if (view.schemaVersion === 2) assert.equal(view.originCandidates[0]!.unresolved, true);
      return;
    }
    case "framing-is-presentation-only": {
      const run = makeFocusedRun(["supported"]);
      const result = scoreFocused(run);
      const finding = buildPresentationFindings({
        claims: run.claims,
        decisions: run.decisions,
        assessments: run.assessments,
        observations: [
          {
            kind: "emotional_language",
            claimId: run.claims[0]!.id,
            submittedSpans: [run.claims[0]!.spans[0]!],
            evidenceAssessmentIds: [],
            description: "The submitted wording contains an observed rhetorical flourish.",
          },
        ],
      });
      assert.equal(result.data!.scorecard.factualScore, 100);
      assert.equal(finding[0]!.evidenceBacked, false);

      const withRating = projectReport({
        ...coreV2Examples.complete,
        candidates: [
          {
            ...coreV2Examples.complete.candidates[0]!,
            providerRating: "high",
          },
        ],
      });
      const withDifferentRating = projectReport({
        ...coreV2Examples.complete,
        candidates: [
          {
            ...coreV2Examples.complete.candidates[0]!,
            providerRating: "low",
          },
        ],
      });
      assert.equal(withRating.schemaVersion, 2);
      assert.equal(withDifferentRating.schemaVersion, 2);
      if (withRating.schemaVersion === 2 && withDifferentRating.schemaVersion === 2) {
        assert.equal(withRating.score.value, withDifferentRating.score.value);
        assert.equal(withRating.sourceContext[0]!.providerRating, "high");
        assert.equal(withDifferentRating.sourceContext[0]!.providerRating, "low");
      }
      return;
    }
    case "image-uncertainty-is-explicit": {
      const port = createDocumentAcquisitionPort({
        now: () => AT,
        ocr: {
          provider: "focused-fixture-ocr",
          modelId: "focused-fixture-ocr-1",
          async recognize() {
            return {
              regions: [
                {
                  text: "Meeting on 2l May",
                  boundingBox: { page: 0, frameId: null, x: 1, y: 2, width: 3, height: 4 },
                  transcriptionUncertain: true,
                },
              ],
            };
          },
        },
      });
      const result = await port.acquireImage({
        data: "data:image/png;base64,iVBORw0KGgo=",
        mimeType: "image/png",
        caption: null,
        role: "submitted_input",
        maxBytes: 10_000,
        signal: new AbortController().signal,
      });
      const snapshot = result.data!.snapshot;
      const ocr = snapshot.locators.find(({ kind }) => kind === "ocr_text");
      assert.equal(ocr?.transcriptionUncertain, true);
      assert.equal(
        snapshot.normalizedText.slice(ocr!.span.start, ocr!.span.end),
        "Meeting on 2l May",
      );
      assert.ok(
        result.issues.some(({ message }) => message.includes("not evidence of fabrication")),
      );
      assert.ok(result.issues.some(({ message }) => message.includes("EXIF/C2PA")));
      const view = projectReport({
        ...coreV2Examples.complete,
        snapshots: [...coreV2Examples.complete.snapshots, snapshot],
      });
      assert.equal(view.schemaVersion, 2);
      if (view.schemaVersion === 2) {
        assert.equal(view.visualVerification.ocr, "uncertain");
        assert.equal(view.visualVerification.observations[0]!.text, "Meeting on 2l May");
        assert.equal(view.visualVerification.observations[0]!.transcriptionUncertain, true);
        assert.equal(view.visualVerification.visualProvenance, "not_verified");
      }
      return;
    }
    case "timeline-uses-immutable-observations": {
      const known = provenanceSnapshot("timeline_known", "https://timeline.example/known", "", [
        {
          type: "published",
          interval: {
            earliest: "2020-01-01T00:00:00.000Z",
            latest: "2020-01-01T00:00:00.000Z",
            precision: "day",
            timezone: "UTC",
          },
          source: "structured_data",
          locatorId: null,
        },
      ]);
      const unknown = provenanceSnapshot(
        "timeline_unknown",
        "https://timeline.example/unknown",
        "",
        [
          {
            type: "event",
            interval: EMPTY_INTERVAL,
            source: "visible_text",
            locatorId: null,
          },
        ],
      );
      const dangling = {
        ...unknown,
        id: "timeline_dangling",
        timestampAssertions: [
          {
            ...unknown.timestampAssertions[0]!,
            locatorId: "missing_locator",
          },
        ],
      } satisfies DocumentSnapshot;
      const entries = buildImmutableTimeline([unknown, known, dangling]);
      assert.equal(entries.length, 3);
      assert.equal(entries[0]!.snapshotId, known.id);
      assert.equal(
        entries.find(({ snapshotId }) => snapshotId === unknown.id)!.assertion.interval.earliest,
        null,
      );
      assert.equal(
        entries.find(({ snapshotId }) => snapshotId === unknown.id)!.status,
        "unresolved",
      );
      assert.equal(
        entries.find(({ snapshotId }) => snapshotId === unknown.id)!.unresolvedReason,
        "timestamp_unknown",
      );
      const danglingEntry = entries.find(({ snapshotId }) => snapshotId === dangling.id)!;
      assert.equal(danglingEntry.status, "unresolved");
      assert.equal(danglingEntry.unresolvedReason, "timestamp_locator_unavailable");
      assert.equal(
        entries.some(({ assertion }) => assertion.type === "captured"),
        false,
      );
      return;
    }
  }
}

function makeFocusedRun(
  labels: ClaimLabel[],
  omittedIndexes: number[] = [],
  ineligibleIndexes: number[] = [],
) {
  const texts = labels.map((_, index) => `Northbridge recorded ${index + 1} incidents in 1998.`);
  const inputText = texts.join("\n\n");
  const input = evidenceSnapshot("focused_input", inputText, { role: "submitted_input" });
  const claims = texts.map((text, index) => {
    const start = texts
      .slice(0, index)
      .reduce((offset, previous) => offset + previous.length + 2, 0);
    return scoringClaim({
      id: `focused_claim_${index + 1}`,
      documentId: input.id,
      text,
      spans: [{ start, end: start + text.length }],
      retrievalText: text,
      proposition: {
        subject: "Northbridge",
        predicate: "recorded",
        object: `${index + 1} incidents`,
        qualifiers: ["in 1998"],
      },
      quantities: [
        {
          rawText: `${index + 1} incidents`,
          value: index + 1,
          unit: "incidents",
          denominatorText: null,
          kind: "count",
        },
      ],
      ...(ineligibleIndexes.includes(index)
        ? { checkability: "not_checkable" as const, material: false }
        : {}),
    });
  });
  const coverage = inputCoverageSchema.parse({
    documentId: input.id,
    segments: claims.map((claim) => ({
      span: claim.spans[0]!,
      disposition: "factual_claim",
      claimIds: [claim.id],
      reason: null,
    })),
    charactersCovered: inputText.length,
    charactersTotal: inputText.length,
    extractionStatus: "complete",
  });
  const selectionResult = selectTopClaims({
    claims,
    snapshots: [input],
    coverage: [coverage],
    inventoryStatus: "complete",
    primarySnapshotId: input.id,
  });
  const assessments: EvidenceAssessment[] = [];
  const assessmentByClaim = new Map<string, EvidenceAssessment[]>();
  const snapshotById = new Map<string, DocumentSnapshot>([[input.id, input]]);
  for (const claim of selectionResult.selectedClaims) {
    const sourceLabel = labels[claims.findIndex(({ id }) => id === claim.id)]!;
    const created: EvidenceAssessment[] = [];
    if (sourceLabel === "supported" || sourceLabel === "contradicted") {
      created.push(
        createAssessment(
          claim,
          `focused_${claim.id}_${sourceLabel}`,
          sourceLabel === "supported" ? "supports" : "contradicts",
        ),
      );
    } else if (sourceLabel === "mixed") {
      created.push(createAssessment(claim, `focused_${claim.id}_support`, "supports"));
      created.push(createAssessment(claim, `focused_${claim.id}_contradict`, "contradicts"));
    } else if (sourceLabel === "misleading") {
      created.push(createAssessment(claim, `focused_${claim.id}_statement`, "supports"));
      created.push(createAssessment(claim, `focused_${claim.id}_context`, "context"));
    }
    for (const assessment of created) {
      assessments.push(assessment);
      assessmentByClaim.set(claim.id, [...(assessmentByClaim.get(claim.id) ?? []), assessment]);
      const snapshot = evidenceSnapshot(assessment.snapshotId, assessment.excerpt.quote);
      snapshotById.set(snapshot.id, snapshot);
    }
  }
  const rawDecisions = selectionResult.selectedClaims.flatMap((claim) => {
    const index = claims.findIndex(({ id }) => id === claim.id);
    if (omittedIndexes.includes(index)) return [];
    const decision = scoringDecision(claim, labels[index]!, assessmentByClaim.get(claim.id) ?? []);
    return [
      labels[index] === "mixed"
        ? decisionSchema.parse({ ...decision, citationIntegrity: "valid" })
        : decision,
    ];
  });
  const published = publishFocusedDecisions({
    claims: selectionResult.claims,
    snapshots: [...snapshotById.values()],
    decisions: rawDecisions,
    assessments,
  });
  return {
    claims: selectionResult.claims,
    selection: selectionResult.selection,
    input,
    snapshots: [...snapshotById.values()],
    assessments,
    decisions: published.decisions,
    coverage: [coverage],
  };
}

function createAssessment(claim: ClaimV2, id: string, relation: EvidenceAssessment["relation"]) {
  const snapshot = evidenceSnapshot(id, `Immutable evidence for ${claim.id}.`);
  return {
    ...scoringAssessment(claim, id, relation),
    id: `assessment_${id}`,
    snapshotId: snapshot.id,
    excerpt: {
      span: { start: 0, end: snapshot.normalizedText.length },
      quote: snapshot.normalizedText,
      locatorId: snapshot.locators[0]!.id,
    },
  } satisfies EvidenceAssessment;
}

function scoreFocused(
  run: FocusedRun,
  status: {
    inputStatus?: "complete" | "partial" | "unavailable" | "failed";
    extractionStatus?: "complete" | "partial" | "unavailable" | "failed";
  } = {},
) {
  return scoreReportV2({
    claims: run.claims,
    decisions: run.decisions,
    assessments: run.assessments,
    graphs: [],
    snapshots: run.snapshots,
    focusedSelection: run.selection,
    coverage: run.coverage,
    inputStatus: status.inputStatus ?? "complete",
    extractionStatus: status.extractionStatus ?? "complete",
    at: AT,
  });
}
