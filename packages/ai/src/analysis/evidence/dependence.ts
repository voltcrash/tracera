import type { DocumentSnapshot, EvidenceAssessment } from "@repo/contracts/analysis";
import { evidenceAssessmentSchema } from "@repo/contracts/analysis";
import { stableId } from "./validation";

export function assignSourceDependence(
  assessments: EvidenceAssessment[],
  snapshots: DocumentSnapshot[],
): EvidenceAssessment[] {
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const sourceHosts = new Map(snapshots.map((snapshot) => [snapshot.id, hostname(snapshot)]));
  const citationNames = new Map(
    [...sourceHosts].map(([id, host]) => [
      id,
      host?.split(".")[0]!.toLocaleLowerCase("en-US") ?? null,
    ]),
  );
  const byClaim = new Map<string, EvidenceAssessment[]>();
  for (const assessment of assessments) {
    const values = byClaim.get(assessment.claimId) ?? [];
    values.push(assessment);
    byClaim.set(assessment.claimId, values);
  }
  const output: EvidenceAssessment[] = [];
  for (const claimAssessments of byClaim.values()) {
    const rootsByHash = new Map<string, { assessment: EvidenceAssessment; order: number }>();
    const rootsByPassage = new Map<string, { assessment: EvidenceAssessment; order: number }>();
    const registerRoot = (hash: string, passage: string, assessment: EvidenceAssessment) => {
      const root = { assessment, order: rootsByHash.size };
      rootsByHash.set(hash, root);
      rootsByPassage.set(passage, root);
    };
    const byPublisher = new Map<string, EvidenceAssessment[]>();
    for (const assessment of claimAssessments) {
      const publisher = sourceHosts.get(assessment.snapshotId);
      if (!publisher) continue;
      const values = byPublisher.get(publisher) ?? [];
      values.push(assessment);
      byPublisher.set(publisher, values);
    }
    const snapshotRoots = new Map<string, EvidenceAssessment>();
    for (const assessment of claimAssessments) {
      const snapshot = snapshotById.get(assessment.snapshotId)!;
      const passageKey = normalizePassage(assessment.excerpt.quote);
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
      const byHash = rootsByHash.get(snapshot.contentHash);
      const byPassage = rootsByPassage.get(passageKey);
      const copiedRoot = (
        byHash && byPassage
          ? byHash.order < byPassage.order
            ? byHash
            : byPassage
          : (byHash ?? byPassage)
      )?.assessment;
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

      const cited = findCitedSource(assessment, claimAssessments, citationNames, passageKey);
      if (cited) {
        const citation = update(assessment, {
          dependence: "cites_source",
          dependencyGroupId: cited.dependencyGroupId,
          dependenceLocators: [locator(assessment)],
        });
        output.push(citation);
        registerRoot(snapshot.contentHash, passageKey, cited);
        snapshotRoots.set(snapshot.id, citation);
        continue;
      }

      const publisher = sourceHosts.get(snapshot.id);
      if (
        publisher &&
        byPublisher
          .get(publisher)!
          .some(
            (candidate) =>
              candidate.id !== assessment.id && candidate.snapshotId !== assessment.snapshotId,
          )
      ) {
        const related = update(assessment, {
          dependence: "same_publisher",
          dependencyGroupId: stableId("publisher", publisher),
          dependenceLocators: [locator(assessment)],
        });
        output.push(related);
        registerRoot(snapshot.contentHash, passageKey, related);
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
      registerRoot(snapshot.contentHash, passageKey, root);
      snapshotRoots.set(snapshot.id, root);
    }
  }
  return output;
}

function findCitedSource(
  assessment: EvidenceAssessment,
  all: EvidenceAssessment[],
  citationNames: Map<string, string | null>,
  text: string,
) {
  return all.find((candidate) => {
    if (candidate.id === assessment.id || candidate.snapshotId === assessment.snapshotId) {
      return false;
    }
    const name = citationNames.get(candidate.snapshotId);
    return name !== null && name !== undefined && name.length > 2 && text.includes(name);
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
