import {
  claimSchema,
  runReportSchema,
  type FocusedSelection,
  type FocusedPublicationPolicy,
  type RunContext,
  type RunReport,
} from "@repo/contracts/core-v2";
import { hashValue } from "./hashing.js";
import { RELATED_CONTEXT_NOTICE } from "./report-view.js";

export interface ReuseIdentity {
  /** Optional for compatibility with direct callers; the orchestrator always supplies it. */
  inputHash?: string;
  contentHash: string;
  propositionScopeHash: string;
  versions: RunContext["versions"];
  visibility: RunContext["visibility"];
  asOfTime: string;
  maxAgeMs: number;
  focusedSelectionIdentity?: Pick<
    FocusedSelection,
    "policyVersion" | "selectionVersion" | "maxSelectedClaims"
  > & {
    publicationPolicyVersion: FocusedPublicationPolicy["policyVersion"];
    publicationDecisionVersion: FocusedPublicationPolicy["decisionVersion"];
  };
}

export type ReuseDecision =
  | { reusable: true; report: RunReport; reason: "compatible_exact_content" }
  | {
      reusable: false;
      report: null;
      reason:
        | "no_candidate"
        | "incomplete"
        | "content_changed"
        | "proposition_scope_changed"
        | "version_changed"
        | "visibility_changed"
        | "stale";
    };

/**
 * Candidates are looked up by the caller's exact tenant/owner/visibility scope. Similar
 * stories or images must never be offered here: they are related context, not identity.
 */
export interface ReportReuseLookup {
  maxAgeMs: number;
  findCandidate(request: {
    inputHash: string;
    contentHash: string;
    scope: Pick<RunContext, "tenantId" | "ownerUserId" | "visibility">;
    signal: AbortSignal;
  }): Promise<unknown>;
}

export function propositionScopeHash(claims: RunReport["claims"]) {
  return hashValue(
    claims
      .map((claim) => claimSchema.parse(claim))
      .filter(({ duplicateOfClaimId }) => duplicateOfClaimId === null)
      .map((claim) => ({
        id: claim.id,
        documentId: claim.documentId,
        spans: claim.spans,
        text: claim.text,
        proposition: claim.proposition,
        attribution: claim.attribution,
        negated: claim.negated,
        quantities: claim.quantities,
        time: claim.time,
        place: claim.place,
        unresolvedContext: claim.unresolvedContext,
        checkability: claim.checkability,
        material: claim.material,
        coverageDisposition: claim.coverageDisposition,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
}

export function decideReportReuse(candidate: unknown, identity: ReuseIdentity): ReuseDecision {
  if (candidate === null || candidate === undefined) {
    return { reusable: false, report: null, reason: "no_candidate" };
  }
  const parsed = runReportSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.status !== "complete" ||
    !parsed.data.scorecard ||
    parsed.data.evidenceSetHash === null ||
    parsed.data.replayManifest.evidenceSetHash !== parsed.data.evidenceSetHash
  ) {
    return { reusable: false, report: null, reason: "incomplete" };
  }
  const report = parsed.data;
  if (identity.inputHash !== undefined && report.replayManifest.inputHash !== identity.inputHash) {
    return { reusable: false, report: null, reason: "content_changed" };
  }
  const primary = report.snapshots.find(({ id }) => id === report.primarySnapshotId);
  if (!primary || primary.contentHash !== identity.contentHash) {
    return { reusable: false, report: null, reason: "content_changed" };
  }
  if (propositionScopeHash(report.claims) !== identity.propositionScopeHash) {
    return { reusable: false, report: null, reason: "proposition_scope_changed" };
  }
  if (identity.focusedSelectionIdentity !== undefined) {
    const focused = report.focusedSelection;
    if (
      focused === undefined ||
      report.focusedPublicationPolicy === undefined ||
      hashValue({
        policyVersion: focused.policyVersion,
        selectionVersion: focused.selectionVersion,
        maxSelectedClaims: focused.maxSelectedClaims,
        publicationPolicyVersion: report.focusedPublicationPolicy.policyVersion,
        publicationDecisionVersion: report.focusedPublicationPolicy.decisionVersion,
      }) !== hashValue(identity.focusedSelectionIdentity)
    ) {
      return { reusable: false, report: null, reason: "version_changed" };
    }
  }
  if (hashValue(report.replayManifest.versions) !== hashValue(identity.versions)) {
    return { reusable: false, report: null, reason: "version_changed" };
  }
  if (report.visibility !== identity.visibility) {
    return { reusable: false, report: null, reason: "visibility_changed" };
  }
  const age = Date.parse(identity.asOfTime) - Date.parse(report.asOfTime);
  if (!Number.isFinite(age) || age < 0 || age > identity.maxAgeMs) {
    return { reusable: false, report: null, reason: "stale" };
  }
  return { reusable: true, report, reason: "compatible_exact_content" };
}

export function relatedContextNotice() {
  return RELATED_CONTEXT_NOTICE;
}
