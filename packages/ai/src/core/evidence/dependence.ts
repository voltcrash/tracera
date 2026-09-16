import type { DocumentSnapshot, EvidenceAssessment } from "@repo/contracts/core-v2";
import { evidenceAssessmentSchema } from "@repo/contracts/core-v2";
import { stableId } from "./validation";

export function assignSourceDependence(
  assessments: EvidenceAssessment[],
  snapshots: DocumentSnapshot[],
): EvidenceAssessment[] {
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const byClaim = new Map<string, EvidenceAssessment[]>();
  for (const assessment of assessments) {
    const values = byClaim.get(assessment.claimId) ?? [];
    values.push(assessment);
    byClaim.set(assessment.claimId, values);
  }
  const output: EvidenceAssessment[] = [];
  for (const claimAssessments of byClaim.values()) {
    const roots = new Map<string, EvidenceAssessment>();
    const snapshotRoots = new Map<string, EvidenceAssessment>();
    for (const assessment of claimAssessments) {
      const snapshot = snapshotById.get(assessment.snapshotId)!;
      const passageKey = normalizePassage(assessment.excerpt.quote);
      const duplicateKey = `${snapshot.contentHash}\u0000${passageKey}`;
      const sameSnapshot = snapshotRoots.get(snapshot.id);
      if (sameSnapshot) {
        output.push(
          update(assessment, {
            dependence: sameSnapshot.dependence,
            dependencyGroupId: sameSnapshot.dependencyGroupId,
            dependenceLocators:
              sameSnapshot.dependence === "independent" || sameSnapshot.dependence === "unknown"
                ? []
                : [locator(sameSnapshot)],
          }),
        );
        continue;
      }
      const copiedRoot = findCopiedRoot(roots, snapshot.contentHash, passageKey);
      if (copiedRoot) {
        const copied = update(assessment, {
          dependence: "syndicated_copy",
          dependencyGroupId: copiedRoot.dependencyGroupId,
          dependenceLocators: [locator(copiedRoot)],
        });
        output.push(copied);
        snapshotRoots.set(snapshot.id, copied);
        continue;
      }

      const cited = findCitedSource(assessment, claimAssessments, snapshotById);
      if (cited) {
        const citation = update(assessment, {
          dependence: "cites_source",
          dependencyGroupId: cited.dependencyGroupId,
          dependenceLocators: [locator(assessment)],
        });
        output.push(citation);
        roots.set(duplicateKey, cited);
        snapshotRoots.set(snapshot.id, citation);
        continue;
      }

      const publisher = hostname(snapshot);
      if (
        publisher &&
        claimAssessments.some(
          (candidate) =>
            candidate.id !== assessment.id &&
            candidate.snapshotId !== assessment.snapshotId &&
            hostname(snapshotById.get(candidate.snapshotId)!) === publisher,
        )
      ) {
        const related = update(assessment, {
          dependence: "same_publisher",
          dependencyGroupId: stableId("publisher", publisher),
          dependenceLocators: [locator(assessment)],
        });
        output.push(related);
        roots.set(duplicateKey, related);
        snapshotRoots.set(snapshot.id, related);
        continue;
      }

      const establishedPrimary =
        assessment.directness === "primary" && snapshot.role !== "submitted_input";
      const root = update(assessment, {
        dependence: establishedPrimary ? "independent" : "unknown",
        dependencyGroupId: stableId("origin", snapshot.contentHash),
        dependenceLocators: [],
      });
      output.push(root);
      roots.set(duplicateKey, root);
      snapshotRoots.set(snapshot.id, root);
    }
  }
  return output;
}

function findCopiedRoot(
  roots: Map<string, EvidenceAssessment>,
  contentHash: string,
  passageKey: string,
) {
  for (const [key, assessment] of roots) {
    if (key.startsWith(`${contentHash}\u0000`) || key.endsWith(`\u0000${passageKey}`)) {
      return assessment;
    }
  }
  return undefined;
}

function findCitedSource(
  assessment: EvidenceAssessment,
  all: EvidenceAssessment[],
  snapshots: Map<string, DocumentSnapshot>,
) {
  const text = normalizePassage(assessment.excerpt.quote);
  return all.find((candidate) => {
    if (candidate.id === assessment.id || candidate.snapshotId === assessment.snapshotId) {
      return false;
    }
    const source = snapshots.get(candidate.snapshotId)!;
    const url = source.canonicalUrl ?? source.finalUrl ?? source.originalUrl;
    if (!url) return false;
    const host = new URL(url).hostname.replace(/^www\./u, "").split(".")[0]!;
    return host.length > 2 && text.includes(host.toLocaleLowerCase("en-US"));
  });
}

function hostname(snapshot: DocumentSnapshot) {
  const url = snapshot.canonicalUrl ?? snapshot.finalUrl ?? snapshot.originalUrl;
  return url ? new URL(url).hostname.replace(/^www\./u, "") : null;
}

function locator(assessment: EvidenceAssessment) {
  return {
    snapshotId: assessment.snapshotId,
    span: assessment.excerpt.span,
    quote: assessment.excerpt.quote,
  };
}

function update(
  assessment: EvidenceAssessment,
  values: Pick<EvidenceAssessment, "dependence" | "dependencyGroupId" | "dependenceLocators">,
) {
  return evidenceAssessmentSchema.parse({ ...assessment, ...values });
}

function normalizePassage(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replaceAll(/\s+/gu, " ").trim();
}
