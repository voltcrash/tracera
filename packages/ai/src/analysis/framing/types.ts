import type { Claim, PresentationFinding, Span } from "@repo/contracts/analysis";

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
      claimId: Claim["id"];
      submittedSpans: Span[];
      evidenceAssessmentIds: [];
      description: string;
    }
  | {
      kind: EvidenceBackedFindingKind;
      claimId: Claim["id"];
      submittedSpans: Span[];
      evidenceAssessmentIds: string[];
      description: string;
    };
