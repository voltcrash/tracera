import { createHash } from "node:crypto";
import type { DocumentSnapshot, EvidenceAssessment } from "@repo/contracts/core-v2";

export function hashValue(value: unknown) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Submitted input is excluded: it cannot corroborate itself, so it is not part of the evidence set. */
export function evidenceSetHash(
  snapshots: DocumentSnapshot[],
  assessments: EvidenceAssessment[],
): string {
  return hashValue({
    snapshots: snapshotIdentity(snapshots.filter(({ role }) => role !== "submitted_input")),
    assessments: [...assessments].sort((a, b) => compare(a.id, b.id)),
  });
}

export function snapshotIdentity(snapshots: DocumentSnapshot[]) {
  return snapshots
    .map(({ id, contentHash }) => ({ id, contentHash }))
    .sort((a, b) => compare(a.id, b.id));
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
