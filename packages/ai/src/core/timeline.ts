import {
  documentSnapshotSchema,
  type DocumentSnapshot,
  type TimestampAssertion,
} from "@repo/contracts/core-v2";

export const IMMUTABLE_TIMELINE_NOTICE =
  "Timeline entries are immutable timestamp observations from stored snapshots; unknown times remain unresolved.";

export interface ImmutableTimelineEntry {
  id: string;
  snapshotId: string;
  snapshotRole: DocumentSnapshot["role"];
  sourceUrl: string | null;
  acquiredAt: string;
  assertion: TimestampAssertion;
  status: "observed" | "unresolved";
  unresolvedReason: "timestamp_locator_unavailable" | "timestamp_unknown" | null;
}

/**
 * Projects only timestamp assertions already stored on immutable snapshots.
 * It never adds a guessed event, publication date, or acquisition date as an assertion.
 */
export function buildImmutableTimeline(input: DocumentSnapshot[]): ImmutableTimelineEntry[] {
  const snapshots = input.map((snapshot) => documentSnapshotSchema.parse(snapshot));
  const seen = new Set<string>();
  const entries = snapshots.flatMap((snapshot) =>
    snapshot.timestampAssertions.flatMap((assertion, index) => {
      const id = `${snapshot.id}:timestamp:${index}`;
      if (seen.has(id)) throw new Error(`Duplicate immutable timeline entry: ${id}.`);
      seen.add(id);
      const locatorAvailable =
        assertion.locatorId === null ||
        snapshot.locators.some(({ id }) => id === assertion.locatorId);
      const timestampKnown =
        assertion.interval.earliest !== null && assertion.interval.latest !== null;
      const unresolvedReason = !locatorAvailable
        ? "timestamp_locator_unavailable"
        : timestampKnown
          ? null
          : "timestamp_unknown";
      return [
        {
          id,
          snapshotId: snapshot.id,
          snapshotRole: snapshot.role,
          sourceUrl: snapshot.canonicalUrl ?? snapshot.finalUrl ?? snapshot.originalUrl,
          acquiredAt: snapshot.acquiredAt,
          assertion,
          status: unresolvedReason === null ? "observed" : "unresolved",
          unresolvedReason,
        } satisfies ImmutableTimelineEntry,
      ];
    }),
  );
  return entries.sort(compareTimelineEntries);
}

function compareTimelineEntries(left: ImmutableTimelineEntry, right: ImmutableTimelineEntry) {
  return (
    compareNullable(left.assertion.interval.earliest, right.assertion.interval.earliest) ||
    left.acquiredAt.localeCompare(right.acquiredAt) ||
    left.snapshotId.localeCompare(right.snapshotId) ||
    left.id.localeCompare(right.id)
  );
}

function compareNullable(left: string | null, right: string | null) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}
