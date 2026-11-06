import type { Claim, DocumentSnapshot, EvidenceAssessment } from "@repo/contracts/analysis";
import { assignSourceDependence } from "./dependence";
import { buildSufficiencyFeedback } from "./sufficiency";
import { stableId } from "./validation";

export function accumulateEvidence(
  claims: Claim[],
  snapshots: DocumentSnapshot[],
  ...batches: EvidenceAssessment[][]
) {
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const all = [
    ...new Map(batches.flat().map((assessment) => [assessment.id, assessment])).values(),
  ];
  all.sort((a, b) => {
    const left = snapshotById.get(a.snapshotId);
    const right = snapshotById.get(b.snapshotId);
    if (!left || !right) throw new Error("Evidence references an unavailable snapshot.");
    return (
      left.acquiredAt.localeCompare(right.acquiredAt) ||
      left.id.localeCompare(right.id) ||
      a.id.localeCompare(b.id)
    );
  });
  const assessments = assignSourceDependence(
    all.map((assessment) => {
      const snapshot = snapshotById.get(assessment.snapshotId);
      if (!snapshot) throw new Error("Evidence references an unavailable snapshot.");
      return {
        ...assessment,
        dependence: "unknown" as const,
        dependencyGroupId: stableId("origin", snapshot.contentHash),
        dependenceLocators: [],
      };
    }),
    snapshots,
  );
  return { assessments, sufficiency: buildSufficiencyFeedback(claims, assessments) };
}
