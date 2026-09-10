import type { EvaluationDataset, EvaluationSplit } from "./schemas.js";

export interface DatasetValidationIssue {
  code:
    | "content_hash"
    | "duplicate_content"
    | "event_split_leakage"
    | "source_family_split_leakage"
    | "temporal_leakage";
  message: string;
  ids: string[];
}

export function validateSplitLeakage(dataset: EvaluationDataset): DatasetValidationIssue[] {
  const issues: DatasetValidationIssue[] = [];
  issues.push(...groupLeakage(dataset, "eventGroupId", "event_split_leakage"));
  issues.push(...groupLeakage(dataset, "sourceFamilyId", "source_family_split_leakage"));

  const hashes = new Map<string, { id: string; splitId: EvaluationSplit }>();
  for (const document of dataset.documents) {
    const previous = hashes.get(document.contentHash);
    if (previous && previous.splitId !== document.splitId) {
      issues.push({
        code: "duplicate_content",
        message: `Identical content appears in ${previous.splitId} and ${document.splitId}.`,
        ids: [previous.id, document.id],
      });
    } else {
      hashes.set(document.contentHash, { id: document.id, splitId: document.splitId });
    }
  }

  const evidence = new Map(dataset.evidenceDocuments.map((document) => [document.id, document]));
  const excerpts = new Map(dataset.excerpts.map((excerpt) => [excerpt.id, excerpt]));
  const inputs = new Map(dataset.documents.map((document) => [document.id, document]));
  for (const claim of dataset.claims) {
    const input = inputs.get(claim.documentId);
    if (!input) continue;
    for (const excerptId of claim.evidenceExcerptIds) {
      const excerpt = excerpts.get(excerptId);
      const evidenceDocument = excerpt ? evidence.get(excerpt.evidenceDocumentId) : undefined;
      if (
        evidenceDocument &&
        Date.parse(evidenceDocument.acquiredAt) > Date.parse(input.asOfTime)
      ) {
        issues.push({
          code: "temporal_leakage",
          message: `Evidence ${evidenceDocument.id} was acquired after the as-of time for ${claim.id}.`,
          ids: [claim.id, evidenceDocument.id],
        });
      }
    }
  }
  return issues;
}

function groupLeakage(
  dataset: EvaluationDataset,
  key: "eventGroupId" | "sourceFamilyId",
  code: "event_split_leakage" | "source_family_split_leakage",
) {
  const groups = new Map<string, Map<EvaluationSplit, string[]>>();
  for (const document of dataset.documents) {
    const splits = groups.get(document[key]) ?? new Map<EvaluationSplit, string[]>();
    splits.set(document.splitId, [...(splits.get(document.splitId) ?? []), document.id]);
    groups.set(document[key], splits);
  }
  return [...groups.entries()]
    .filter(([, splits]) => splits.size > 1)
    .map(([group, splits]) => ({
      code,
      message: `${key} ${group} crosses splits: ${[...splits.keys()].join(", ")}.`,
      ids: [...splits.values()].flat(),
    }));
}
