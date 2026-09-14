import type {
  DocumentSnapshot,
  EvidenceAssessment,
  ProvenanceGraph,
  TimeInterval,
  TimestampAssertion,
} from "@repo/contracts/core-v2";

type Node = ProvenanceGraph["nodes"][number];
type Edge = ProvenanceGraph["edges"][number];

export function classifyNode(
  snapshot: DocumentSnapshot,
  assessments: EvidenceAssessment[],
): Node["role"] {
  if (snapshot.role === "submitted_input") return "submitted_input";
  if (snapshot.role === "archive_capture") return "archive_capture";
  if (
    snapshot.role === "primary_record" ||
    assessments.some(({ directness }) => directness === "primary")
  )
    return "primary_record";
  if (assessments.some(({ dependence }) => dependence === "syndicated_copy")) return "syndication";
  return "report";
}

export function hasValidatedClaim(assessments: EvidenceAssessment[]) {
  return assessments.some(
    (assessment) =>
      assessment.validationStatus === "validated" &&
      assessment.relation !== "irrelevant" &&
      assessment.relation !== "insufficient" &&
      Object.values(assessment.applicability).every((value) => value === "applicable"),
  );
}

export function detectChronologyConflicts(nodes: Node[], edges: Edge[] = []) {
  const conflicts: ProvenanceGraph["chronologyConflicts"] = [];
  for (const node of nodes) {
    const published = node.timestamps.filter(({ type }) => type === "published");
    const updated = node.timestamps.filter(({ type }) => type === "updated");
    const observed = node.timestamps.filter(
      ({ type }) => type === "archived" || type === "captured",
    );
    for (const update of updated) {
      for (const publication of published) {
        if (strictlyBefore(update.interval, publication.interval)) {
          conflicts.push({
            snapshotIds: [node.snapshotId, node.snapshotId],
            description: "The declared update interval precedes the declared publication interval.",
          });
        }
      }
    }
    for (const observation of node.claimPresentInContent ? observed : []) {
      for (const publication of published) {
        if (strictlyBefore(observation.interval, publication.interval)) {
          conflicts.push({
            snapshotIds: [node.snapshotId, node.snapshotId],
            description:
              "An archive or capture establishes claim-level existence before the declared publication interval.",
          });
        }
      }
    }
  }
  const nodesById = new Map(nodes.map((node) => [node.snapshotId, node]));
  for (const edge of edges.filter(({ type }) => type === "archives")) {
    const capture = nodesById.get(edge.fromSnapshotId);
    const original = nodesById.get(edge.toSnapshotId);
    if (capture === undefined || original === undefined || !capture.claimPresentInContent) continue;
    for (const observed of capture.timestamps.filter(
      ({ type }) => type === "archived" || type === "captured",
    )) {
      for (const publication of original.timestamps.filter(({ type }) => type === "published")) {
        if (strictlyBefore(observed.interval, publication.interval)) {
          conflicts.push({
            snapshotIds: [capture.snapshotId, original.snapshotId],
            description:
              "A validated archive capture establishes claim-level existence before the original's declared publication interval.",
          });
        }
      }
    }
  }
  return conflicts;
}

export function detectCycles(nodes: Node[], edges: Edge[]) {
  const adjacency = new Map(nodes.map(({ snapshotId }) => [snapshotId, [] as string[]]));
  for (const edge of edges) adjacency.get(edge.fromSnapshotId)?.push(edge.toSnapshotId);
  const cycles = new Map<string, string[]>();
  const visit = (node: string, path: string[], active: Set<string>) => {
    const position = path.indexOf(node);
    if (position >= 0) {
      const cycle = [...path.slice(position), node];
      const canonical = canonicalCycle(cycle);
      cycles.set(canonical.join("\0"), canonical);
      return;
    }
    if (active.has(node)) return;
    active.add(node);
    for (const target of adjacency.get(node) ?? []) visit(target, [...path, node], active);
    active.delete(node);
  };
  for (const node of adjacency.keys()) visit(node, [], new Set());
  return [...cycles.values()].sort((left, right) => left.join().localeCompare(right.join()));
}

export function rankRoots(
  nodes: Node[],
  assessments: EvidenceAssessment[],
  snapshots: DocumentSnapshot[] = [],
) {
  const candidates: ProvenanceGraph["candidateRoots"] = [];
  const claimNodes = nodes.filter(({ claimPresentInContent }) => claimPresentInContent);
  const primaryRecords = claimNodes.filter(({ role }) => role === "primary_record");
  for (const node of primaryRecords) {
    candidates.push({
      snapshotId: node.snapshotId,
      rootKind: "primary_record",
      rank: 1,
      signals: ["Acquired primary record containing the scoped claim"],
    });
  }
  const earliest = tiedEarliest(claimNodes);
  const observedRank = primaryRecords.length > 0 ? 2 : 1;
  for (const node of earliest) {
    const dependence = assessments.filter(({ snapshotId }) => snapshotId === node.snapshotId);
    candidates.push({
      snapshotId: node.snapshotId,
      rootKind: "earliest_observed_statement",
      rank: observedRank,
      signals: [
        "Earliest observed statement within the searched sources and date range",
        dependence.some(({ dependence: value }) => value === "unknown")
          ? "Source dependence is unknown and was not treated as independent"
          : "Claim presence was validated against an immutable snapshot",
      ],
    });
  }
  const reports = claimNodes.filter(({ role }) =>
    (["report", "aggregator", "syndication", "corpus_record"] as Node["role"][]).includes(role),
  );
  const acquiredAt = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot.acquiredAt]));
  const reportTimes = reports.flatMap((node) => {
    const time = acquiredAt.get(node.snapshotId);
    return time === undefined ? [] : [{ node, time }];
  });
  reportTimes.sort((left, right) => left.time.localeCompare(right.time));
  const earliestReports = reportTimes
    .filter(({ time }) => time === reportTimes[0]?.time)
    .map(({ node }) => node);
  const reportRank = primaryRecords.length > 0 ? 3 : earliest.length > 0 ? 2 : 1;
  for (const node of earliestReports) {
    candidates.push({
      snapshotId: node.snapshotId,
      rootKind: "earliest_retrieved_report",
      rank: reportRank,
      signals: ["Earliest retrieved report within the bounded traversal"],
    });
  }
  return [
    ...new Map(candidates.map((item) => [`${item.snapshotId}\0${item.rootKind}`, item])).values(),
  ];
}

export function searchedDateRange(nodes: Node[], asOfTime: string): TimeInterval {
  const earliest = nodes
    .flatMap(({ timestamps }) => timestamps)
    .flatMap((item) => (item.interval.earliest === null ? [] : [item.interval.earliest]));
  return {
    earliest: earliest.length === 0 ? null : earliest.sort()[0]!,
    latest: asOfTime,
    precision: "day",
    timezone: "UTC",
  };
}

function tiedEarliest(nodes: Node[]) {
  const dated = nodes.flatMap((node) => {
    const intervals = node.timestamps
      .filter(({ type }) =>
        (["published", "indexed", "archived", "captured"] as TimestampAssertion["type"][]).includes(
          type,
        ),
      )
      .map(({ interval }) => interval)
      .filter(knownInterval);
    if (intervals.length === 0) return [];
    intervals.sort((left, right) => left.earliest.localeCompare(right.earliest));
    return [{ node, interval: intervals[0]! }];
  });
  if (dated.length === 0) return [];
  dated.sort((left, right) => left.interval.earliest.localeCompare(right.interval.earliest));
  const first = dated[0]!.interval;
  return dated.filter(({ interval }) => overlaps(interval, first)).map(({ node }) => node);
}

function knownInterval(
  interval: TimeInterval,
): interval is TimeInterval & { earliest: string; latest: string } {
  return interval.earliest !== null && interval.latest !== null;
}

function strictlyBefore(left: TimeInterval, right: TimeInterval) {
  return left.latest !== null && right.earliest !== null && left.latest < right.earliest;
}

function overlaps(
  left: TimeInterval & { earliest: string; latest: string },
  right: TimeInterval & { earliest: string; latest: string },
) {
  return left.earliest <= right.latest && right.earliest <= left.latest;
}

function canonicalCycle(cycle: string[]) {
  const body = cycle.slice(0, -1);
  const rotations = body.map((_, index) => [...body.slice(index), ...body.slice(0, index)]);
  rotations.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
  return [...rotations[0]!, rotations[0]![0]!];
}

export function archiveAssertion(interval: TimeInterval): TimestampAssertion {
  return { type: "archived", interval, source: "archive_service", locatorId: null };
}
