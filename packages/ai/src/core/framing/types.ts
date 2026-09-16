import type { ClaimV2, PresentationFinding, Span } from "@repo/contracts/core-v2";

export type TextObservedFindingKind = Extract<
  PresentationFinding["kind"],
  "emotional_language" | "attributed_quotation" | "negative_reporting"
>;

export type EvidenceBackedFindingKind = Extract<
  PresentationFinding["kind"],
  "material_context_omission" | "material_skew"
>;

export type PresentationObservation =
  | {
      kind: TextObservedFindingKind;
      claimId: ClaimV2["id"];
      submittedSpans: Span[];
      evidenceAssessmentIds: [];
      description: string;
    }
  | {
      kind: EvidenceBackedFindingKind;
      claimId: ClaimV2["id"];
      submittedSpans: Span[];
      evidenceAssessmentIds: string[];
      description: string;
    };
