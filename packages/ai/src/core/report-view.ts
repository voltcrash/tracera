import {
  versionedRunReportSchema,
  type ClaimLabel,
  type ClaimV2,
  type EvidenceRelation,
  type RunReport,
  type Scorecard,
} from "@repo/contracts/core-v2";

export const RELATED_CONTEXT_NOTICE =
  "Related stories and similar images are context only; they are not identical submissions or verified evidence.";

export type ReportView = { schemaVersion: 1; checkId: string; href: string } | CoreV2ReportView;

export interface CoreV2ReportView {
  schemaVersion: 2;
  runId: string;
  status: RunReport["status"];
  asOfTime: string;
  createdAt: string;
  reusedFromRunId: string | null;
  score: {
    label: string;
    value: number | null;
    formulaVersion: Scorecard["formulaVersion"] | null;
    counts: Scorecard["counts"] | null;
    resolutionCoverage: number | null;
    extractionCoverage: number | null;
    nullReasons: string[];
  };
  claims: Array<{
    id: string;
    text: string;
    disposition: ClaimV2["coverageDisposition"];
    publishedLabel: ClaimLabel | null;
    diagnosticLabel: ClaimLabel | null;
    justification: string | null;
    conflict: boolean;
    evidence: Array<{
      assessmentId: string;
      snapshotId: string;
      relation: EvidenceRelation;
      quote: string;
      start: number;
      end: number;
      sourceUrl: string | null;
      excerptHref: string;
    }>;
  }>;
  deferredClaims: Array<{ id: string; text: string }>;
  focusedSelection: {
    selectedClaimIds: string[];
    inventoriedClaims: number;
    analyzedClaims: number;
    deferredClaims: number;
    excludedClaims: number;
    shortfallReason: string | null;
  } | null;
  conflicts: Array<{ claimId: string; description: string }>;
  originCandidates: Array<{
    claimId: string;
    claimText: string;
    candidates: Array<{ snapshotId: string; rootKind: string; rank: number; url: string | null }>;
    unresolved: boolean;
  }>;
  visualVerification: {
    ocr: "not_applicable" | "inspected" | "uncertain";
    visualProvenance: "not_verified";
  };
  unresolvedReasons: RunReport["unresolvedReasons"];
  relatedContextNotice: string;
}

export function projectReport(value: unknown, apiBase = "/api/tracera"): ReportView {
  const report = versionedRunReportSchema.parse(value);
  if (report.schemaVersion === 1) {
    return {
      schemaVersion: 1,
      checkId: report.checkId,
      href: `/trace/${encodeURIComponent(report.checkId)}`,
    };
  }
  return projectCoreV2Report(report, apiBase);
}

function projectCoreV2Report(report: RunReport, apiBase: string): CoreV2ReportView {
  const snapshots = new Map(report.snapshots.map((item) => [item.id, item]));
  const assessments = new Map(report.assessments.map((item) => [item.id, item]));
  const decisions = new Map(report.decisions.map((item) => [item.claimId, item]));
  const claimText = new Map(report.claims.map((item) => [item.id, item.text]));
  const canonical = report.claims.filter(({ duplicateOfClaimId }) => duplicateOfClaimId === null);
  const locators = report.snapshots.flatMap(({ locators }) => locators);
  const ocrLocators = locators.filter(({ kind }) => kind === "ocr_text");
  const conflicts = [
    ...report.decisions
      .filter(
        ({ publishedLabel, diagnosticLabel }) =>
          publishedLabel === "mixed" || diagnosticLabel === "mixed",
      )
      .map(({ claimId }) => ({
        claimId,
        description: "Applicable supporting and contradicting evidence remain unresolved.",
      })),
    ...report.provenance.flatMap(({ claimId, chronologyConflicts }) =>
      chronologyConflicts.map(({ description }) => ({ claimId, description })),
    ),
  ];
  const conflicted = new Set(conflicts.map(({ claimId }) => claimId));
  const score = report.scorecard;
  const selectedClaimIds = report.focusedSelection
    ? new Set(report.focusedSelection.selectedClaimIds)
    : null;

  return {
    schemaVersion: 2,
    runId: report.runId,
    status: report.status,
    asOfTime: report.asOfTime,
    createdAt: report.createdAt,
    reusedFromRunId:
      report.replayManifest.runId === report.runId ? null : report.replayManifest.runId,
    score: {
      label: report.focusedSelection
        ? "Supported share of selected claims"
        : "Supported share of resolved claims",
      value: score?.factualScore ?? null,
      formulaVersion: score?.formulaVersion ?? null,
      counts: score?.counts ?? null,
      resolutionCoverage: score?.resolutionCoverage ?? null,
      extractionCoverage: score?.extractionCoverage ?? null,
      nullReasons: score ? score.nullReasons : ["score_not_computed"],
    },
    claims: canonical
      .filter(
        ({ id, coverageDisposition }) =>
          coverageDisposition !== "deferred" &&
          (selectedClaimIds === null || selectedClaimIds.has(id)),
      )
      .map((claim) => {
        const decision = decisions.get(claim.id) ?? null;
        const cited = decision
          ? [
              ...new Set([
                ...decision.supportingAssessmentIds,
                ...decision.contradictingAssessmentIds,
                ...decision.correctiveContextAssessmentIds,
              ]),
            ]
          : [];
        return {
          id: claim.id,
          text: claim.text,
          disposition: claim.coverageDisposition,
          publishedLabel: decision?.publishedLabel ?? null,
          diagnosticLabel: decision?.diagnosticLabel ?? null,
          justification: decision?.justification ?? null,
          conflict: conflicted.has(claim.id),
          evidence: cited.flatMap((id) => {
            const assessment = assessments.get(id);
            if (!assessment) return [];
            const snapshot = snapshots.get(assessment.snapshotId);
            const { span, quote } = assessment.excerpt;
            return [
              {
                assessmentId: id,
                snapshotId: assessment.snapshotId,
                relation: assessment.relation,
                quote,
                start: span.start,
                end: span.end,
                sourceUrl:
                  snapshot?.canonicalUrl ?? snapshot?.finalUrl ?? snapshot?.originalUrl ?? null,
                excerptHref: `${apiBase}/v2/runs/${encodeURIComponent(report.runId)}/evidence/${encodeURIComponent(assessment.snapshotId)}?start=${span.start}&end=${span.end}`,
              },
            ];
          }),
        };
      }),
    deferredClaims: canonical
      .filter(({ coverageDisposition }) => coverageDisposition === "deferred")
      .map(({ id, text }) => ({ id, text })),
    focusedSelection: report.focusedSelection
      ? {
          selectedClaimIds: report.focusedSelection.selectedClaimIds,
          inventoriedClaims: report.focusedSelection.inventory.totalClaims,
          analyzedClaims: report.focusedSelection.inventory.analyzedClaims,
          deferredClaims: report.focusedSelection.inventory.deferredClaims,
          excludedClaims: report.focusedSelection.inventory.excludedClaims,
          shortfallReason: report.focusedSelection.shortfallReason,
        }
      : null,
    conflicts,
    originCandidates: report.provenance.map((graph) => ({
      claimId: graph.claimId,
      claimText: claimText.get(graph.claimId) ?? graph.claimId,
      candidates: graph.candidateRoots.map((root) => ({
        snapshotId: root.snapshotId,
        rootKind: root.rootKind,
        rank: root.rank,
        url: graph.nodes.find(({ snapshotId }) => snapshotId === root.snapshotId)?.url ?? null,
      })),
      unresolved: graph.candidateRoots.length === 0,
    })),
    visualVerification: {
      ocr:
        ocrLocators.length === 0
          ? "not_applicable"
          : ocrLocators.some(({ transcriptionUncertain }) => transcriptionUncertain)
            ? "uncertain"
            : "inspected",
      visualProvenance: "not_verified",
    },
    unresolvedReasons: report.unresolvedReasons,
    relatedContextNotice: RELATED_CONTEXT_NOTICE,
  };
}
