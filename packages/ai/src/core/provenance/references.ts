import type { DocumentSnapshot } from "@repo/contracts/core-v2";
import type { ProvenanceReference } from "./types";

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gu;
const ATTRIBUTION_PATTERN = /(?:according to|attributed to|reported by|source:)\s*$/iu;

export function extractProvenanceReferences(snapshot: DocumentSnapshot): ProvenanceReference[] {
  const references: ProvenanceReference[] = [];
  for (const match of snapshot.normalizedText.matchAll(URL_PATTERN)) {
    if (match.index === undefined) continue;
    const raw = match[0];
    const url = trimTrailingPunctuation(raw);
    const start = match.index;
    const end = start + url.length;
    const prefix = snapshot.normalizedText.slice(Math.max(0, start - 48), start);
    references.push({
      url,
      type: ATTRIBUTION_PATTERN.test(prefix) ? "attributes_to" : "cites",
      locator: { snapshotId: snapshot.id, span: { start, end }, quote: url },
    });
  }
  return [...new Map(references.map((item) => [`${item.type}\0${item.url}`, item])).values()];
}

function trimTrailingPunctuation(value: string) {
  return value.replace(/[.,;:!?]+$/u, "");
}
