import type { CoreIssue, DocumentSnapshot, StageMetrics } from "@repo/contracts/core-v2";
import type { AuditEvent, ExtractClaimsV2, RunEnvironment } from "../types.js";
import { buildChunkRequest, chunkExtractionSchema, type ChunkExtraction } from "./generation.js";
import { buildInventory, scopeKey, type AcceptedClaim, type SegmentOutcome } from "./inventory.js";
import {
  buildChunks,
  segmentDocument,
  type InventorySegment,
  type SegmentedDocument,
} from "./segmentation.js";
import { validateRawClaim, type ChunkScope, type ClaimDraft } from "./validation.js";

export interface ClaimExtractionOptions {
  maxChunkCharacters?: number;
  overlapCharacters?: number;
  /** Claims beyond this many, in priority order, stay inventoried but deferred. */
  maxAnalyzedClaims?: number | null;
  /** Generation attempts this stage may spend; defaults to the run's external request cap. */
  maxGenerationRequests?: number | null;
  /** Monotonic clock reading after which no further chunk is started. */
  deadlineMonotonicMs?: number | null;
}

export const DEFAULT_MAX_CHUNK_CHARACTERS = 6_000;
export const DEFAULT_OVERLAP_CHARACTERS = 1_500;

const UNUSABLE_EXTRACTION = new Map<DocumentSnapshot["extractionStatus"], CoreIssue["code"]>([
  ["content_unavailable", "content_unavailable"],
  ["blocked", "blocked_page"],
  ["unsupported_format", "unsupported_format"],
]);

export function createExtractClaimsV2(options: ClaimExtractionOptions = {}): ExtractClaimsV2 {
  const maxChunkCharacters = options.maxChunkCharacters ?? DEFAULT_MAX_CHUNK_CHARACTERS;
  const overlapCharacters = options.overlapCharacters ?? DEFAULT_OVERLAP_CHARACTERS;
  if (!Number.isInteger(maxChunkCharacters) || maxChunkCharacters < 200) {
    throw new RangeError("maxChunkCharacters must be an integer of at least 200.");
  }
  if (!Number.isInteger(overlapCharacters) || overlapCharacters < 0) {
    throw new RangeError("overlapCharacters must be a non-negative integer.");
  }

  return async ({ snapshots, primarySnapshotId }, environment) => {
    const { clock } = environment.ports;
    const startedAt = clock.now();
    const startedMs = clock.monotonicMs();
    const usage = {
      requests: 0,
      inputTokens: 0 as number | null,
      outputTokens: 0 as number | null,
      costUsd: 0 as number | null,
    };
    const issues: CoreIssue[] = [];
    const metrics = (): StageMetrics => ({
      startedAt,
      completedAt: clock.now(),
      durationMs: Math.max(0, clock.monotonicMs() - startedMs),
      externalRequests: usage.requests,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    });
    const audit = (kind: AuditEvent["kind"], message: string, snapshotId: string | null = null) =>
      environment.ports.audit.record({
        runId: environment.context.runId,
        stage: "extract_claims",
        kind,
        message,
        claimId: null,
        snapshotId,
        at: clock.now(),
      });
    const finish = async (status: "complete" | "partial" | "unavailable" | "failed") => {
      await audit("stage_finished", `Claim inventory finished with status ${status}.`);
    };
    const canceled = async () => {
      const cancellation = issue("cancellation_requested", "Claim extraction was canceled.");
      await audit("cancellation", cancellation.message);
      await finish("failed");
      return { status: "failed" as const, data: null, issues: [cancellation], metrics: metrics() };
    };
    const withoutData = async (status: "unavailable" | "failed", stageIssues: CoreIssue[]) => {
      await finish(status);
      return { status, data: null, issues: stageIssues, metrics: metrics() };
    };

    await audit("stage_started", "Claim inventory started.");
    if (isCanceled(environment)) return canceled();

    const primary = snapshots.find((snapshot) => snapshot.id === primarySnapshotId);
    if (!primary) {
      return withoutData("failed", [
        issue("snapshot_unavailable", `Primary snapshot ${primarySnapshotId} was not supplied.`),
      ]);
    }
    const unusable = unusableReason(primary);
    if (unusable) return withoutData("unavailable", [unusable]);

    const inputs = [
      primary,
      ...snapshots.filter(
        (snapshot) => snapshot.role === "submitted_input" && snapshot.id !== primary.id,
      ),
    ];
    let incomplete = false;
    const documents: SegmentedDocument[] = [];
    for (const snapshot of inputs) {
      if (snapshot !== primary) {
        const reason = unusableReason(snapshot);
        if (reason) {
          issues.push(reason);
          incomplete = true;
          continue;
        }
      }
      if (snapshot.extractionStatus === "partial") {
        incomplete = true;
        issues.push(
          issue(
            snapshot.limits.truncated ? "truncation" : "content_unavailable",
            snapshot.limits.truncated
              ? "The acquired input was truncated; text beyond the retained limit was not inventoried."
              : "The acquired input is partial; only its retained text was inventoried.",
            snapshot.id,
          ),
        );
      }
      documents.push(segmentDocument(snapshot, documents.length, maxChunkCharacters));
    }

    const primaryDocument = documents[0]!;
    if (primaryDocument.language === "unsupported") {
      return withoutData("unavailable", [
        issue(
          "unsupported_language",
          "The input language is not supported by the validated claim extractor; no claims were inventoried.",
          primary.id,
        ),
      ]);
    }

    const allowance =
      options.maxGenerationRequests === undefined
        ? environment.context.budget.maxExternalRequests
        : options.maxGenerationRequests;
    const costCap = environment.context.budget.maxCostUsd;
    const outcomes = new Map<string, SegmentOutcome>();
    const accepted: AcceptedClaim[] = [];
    let chunksAttempted = 0;
    let chunksFailed = 0;
    let exhausted = false;

    for (const document of documents) {
      const segmentsById = new Map(document.segments.map((segment) => [segment.id, segment]));
      for (const chunk of buildChunks(document, maxChunkCharacters, overlapCharacters)) {
        if (isCanceled(environment)) return canceled();
        const exhaustion = budgetExhaustion(
          usage,
          allowance,
          costCap,
          options,
          clock.monotonicMs(),
        );
        if (exhaustion || exhausted) {
          if (!exhausted && exhaustion) {
            exhausted = true;
            incomplete = true;
            issues.push(issue("budget_exhausted", exhaustion, document.snapshot.id));
            await audit("budget_consumed", exhaustion, document.snapshot.id);
          }
          for (const id of chunk.ownedSegmentIds) outcomes.set(id, { kind: "budget_deferred" });
          continue;
        }

        chunksAttempted += 1;
        let response: ChunkExtraction;
        let counted = false;
        try {
          const generated = await environment.ports.generation.generate(
            buildChunkRequest(chunk, segmentsById, environment.signal),
          );
          usage.requests += Math.max(1, generated.attempts);
          addUsage(usage, generated.usage);
          counted = true;
          const parsed = chunkExtractionSchema.safeParse(generated.value);
          if (!parsed.success)
            throw new Error("The generation output did not match the chunk schema.");
          response = parsed.data;
        } catch (error) {
          if (isCanceled(environment)) return canceled();
          if (!counted) {
            usage.requests += 1;
            usage.inputTokens = null;
            usage.outputTokens = null;
            usage.costUsd = null;
          }
          chunksFailed += 1;
          incomplete = true;
          for (const id of chunk.ownedSegmentIds) outcomes.set(id, { kind: "provider_failed" });
          issues.push(
            issue(
              "provider_failure",
              `Claim extraction for chunk ${chunk.index} failed: ${error instanceof Error ? error.message : "unknown error"}. Its segments are omitted from the inventory.`,
              document.snapshot.id,
            ),
          );
          continue;
        }

        const scope: ChunkScope = {
          document,
          segmentsById,
          chunkSegmentIds: new Set([...chunk.contextSegmentIds, ...chunk.ownedSegmentIds]),
          ownedSegmentIds: new Set(chunk.ownedSegmentIds),
        };
        const rejections = applyDispositions(response, scope, outcomes);
        const chunkClaims = validateChunkClaims(response, scope, rejections);
        for (const message of rejections) {
          incomplete = true;
          issues.push(issue("citation_validation_failed", message, document.snapshot.id));
          await audit("validation_rejected", message, document.snapshot.id);
        }
        for (const claim of chunkClaims) {
          for (const note of claim.draft.notes) {
            issues.push({
              ...issue("ambiguous_input", note, document.snapshot.id),
              severity: "info",
            });
            await audit("validation_rejected", note, document.snapshot.id);
          }
        }
        accepted.push(...chunkClaims);
      }
    }

    if (chunksAttempted > 0 && chunksFailed === chunksAttempted && !exhausted) {
      return withoutData("failed", issues);
    }

    const inventory = buildInventory({
      documents,
      accepted,
      outcomes,
      maxAnalyzedClaims: options.maxAnalyzedClaims ?? null,
    });
    issues.push(...inventory.issues);
    const status = incomplete || inventory.incomplete ? "partial" : "complete";
    await finish(status);
    return {
      status,
      data: { claims: inventory.claims, coverage: inventory.coverage },
      issues,
      metrics: metrics(),
    };
  };
}

export const extractClaimsV2: ExtractClaimsV2 = createExtractClaimsV2();

function applyDispositions(
  response: ChunkExtraction,
  scope: ChunkScope,
  outcomes: Map<string, SegmentOutcome>,
): string[] {
  const rejections: string[] = [];
  const decided = new Set<string>();
  for (const entry of response.segments) {
    if (!scope.chunkSegmentIds.has(entry.segmentId)) {
      rejections.push(
        `A disposition cites segment ${entry.segmentId}, which is not in this chunk.`,
      );
      continue;
    }
    if (!scope.ownedSegmentIds.has(entry.segmentId) || decided.has(entry.segmentId)) continue;
    decided.add(entry.segmentId);
    if (entry.disposition === "factual_claim") {
      outcomes.set(entry.segmentId, { kind: "declared_factual" });
    } else if (entry.reason === null) {
      rejections.push(
        `Segment ${entry.segmentId} was marked ${entry.disposition} without a reason; the disposition is not accepted.`,
      );
    } else {
      outcomes.set(entry.segmentId, {
        kind: "disposition",
        disposition: entry.disposition,
        reason: entry.reason,
      });
    }
  }
  for (const id of scope.ownedSegmentIds) {
    if (!decided.has(id) && !outcomes.has(id)) outcomes.set(id, { kind: "missing" });
  }
  return rejections;
}

function validateChunkClaims(
  response: ChunkExtraction,
  scope: ChunkScope,
  rejections: string[],
): AcceptedClaim[] {
  const counts = new Map<string, number>();
  for (const raw of response.claims) counts.set(raw.localId, (counts.get(raw.localId) ?? 0) + 1);
  const drafts = new Map<string, ClaimDraft>();
  for (const raw of response.claims) {
    if (counts.get(raw.localId)! > 1) {
      rejections.push(`Claim ${raw.localId} rejected: its local ID is used more than once.`);
      continue;
    }
    const result = validateRawClaim(raw, scope);
    if (result.accepted) drafts.set(raw.localId, result.draft);
    else rejections.push(`Claim ${raw.localId} rejected: ${result.reason}.`);
  }

  for (let changed = true; changed;) {
    changed = false;
    for (const [localId, draft] of drafts) {
      const reason = parentFailure(draft, drafts);
      if (reason === null) continue;
      drafts.delete(localId);
      rejections.push(`Claim ${localId} rejected: ${reason}.`);
      changed = true;
    }
  }
  return [...drafts.values()].map((draft) => ({
    draft,
    parent: draft.parentLocalId === null ? null : drafts.get(draft.parentLocalId)!,
  }));
}

function parentFailure(draft: ClaimDraft, drafts: Map<string, ClaimDraft>): string | null {
  if (draft.parentLocalId === null) return null;
  if (draft.parentLocalId === draft.localId) return "a claim cannot be its own parent";
  const parent = drafts.get(draft.parentLocalId);
  if (!parent) return `parent ${draft.parentLocalId} is missing or was rejected`;
  if (scopeKey(parent) === scopeKey(draft)) return "its parent is the same scoped proposition";
  const seen = new Set([draft.localId]);
  for (let cursor: ClaimDraft | undefined = parent; cursor;) {
    if (seen.has(cursor.localId)) return "its parent relation forms a cycle";
    seen.add(cursor.localId);
    cursor = cursor.parentLocalId === null ? undefined : drafts.get(cursor.parentLocalId);
  }
  return null;
}

function unusableReason(snapshot: DocumentSnapshot): CoreIssue | null {
  const code = UNUSABLE_EXTRACTION.get(snapshot.extractionStatus);
  if (code) {
    return issue(
      code,
      `Snapshot content is ${snapshot.extractionStatus}; discovery hints are never inventoried as claims.`,
      snapshot.id,
    );
  }
  const segments = segmentDocument(snapshot, 0, Number.MAX_SAFE_INTEGER).segments.filter(
    (segment: InventorySegment) => segment.substantive,
  );
  if (segments.length === 0) {
    return issue(
      "content_unavailable",
      "The snapshot contains no readable text to inventory.",
      snapshot.id,
    );
  }
  if (segments.every((segment) => segment.handling === "user_caption")) {
    return issue(
      "content_unavailable",
      "Only a user-supplied caption is available; captions are discovery hints, not claims.",
      snapshot.id,
    );
  }
  return null;
}

function budgetExhaustion(
  usage: { requests: number; costUsd: number | null },
  allowance: number | null,
  costCap: number | null,
  options: ClaimExtractionOptions,
  nowMs: number,
): string | null {
  if (allowance !== null && usage.requests >= allowance) {
    return `The claim extraction request allowance of ${allowance} was exhausted.`;
  }
  if (costCap !== null && usage.costUsd !== null && usage.costUsd >= costCap) {
    return `The run cost cap of ${costCap} USD was reached during claim extraction.`;
  }
  if (options.deadlineMonotonicMs != null && nowMs >= options.deadlineMonotonicMs) {
    return "The claim extraction deadline elapsed.";
  }
  return null;
}

function addUsage(
  total: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null },
  next: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null },
) {
  total.inputTokens =
    total.inputTokens === null || next.inputTokens === null
      ? null
      : total.inputTokens + next.inputTokens;
  total.outputTokens =
    total.outputTokens === null || next.outputTokens === null
      ? null
      : total.outputTokens + next.outputTokens;
  total.costUsd =
    total.costUsd === null || next.costUsd === null ? null : total.costUsd + next.costUsd;
}

function isCanceled(environment: RunEnvironment) {
  return environment.signal.aborted || environment.context.cancellation.requested;
}

function issue(
  code: CoreIssue["code"],
  message: string,
  snapshotId: string | null = null,
): CoreIssue {
  return { code, severity: "warning", message, claimId: null, snapshotId, url: null };
}
