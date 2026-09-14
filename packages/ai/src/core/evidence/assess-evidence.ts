import type {
  CoreIssue,
  DocumentSnapshot,
  EvidenceAssessment,
  StageMetrics,
} from "@repo/contracts/core-v2";
import type {
  AssessEvidenceV2,
  AssessEvidenceV2Data,
  AuditEvent,
  RunEnvironment,
} from "../types.js";
import { assignSourceDependence } from "./dependence.js";
import { buildAssessmentRequest } from "./generation.js";
import { buildSufficiencyFeedback } from "./sufficiency.js";
import type { EvidenceAssessmentOptions } from "./types.js";
import { validateAssessment } from "./validation.js";

export const assessEvidenceV2: AssessEvidenceV2 = createAssessEvidenceV2();

export function createAssessEvidenceV2(options: EvidenceAssessmentOptions = {}): AssessEvidenceV2 {
  return async (input, environment) => assess(input, environment, options);
}

async function assess(
  input: Parameters<AssessEvidenceV2>[0],
  environment: RunEnvironment,
  options: EvidenceAssessmentOptions,
): Promise<ReturnType<AssessEvidenceV2> extends Promise<infer T> ? T : never> {
  const startedAt = environment.ports.clock.now();
  const startedMs = environment.ports.clock.monotonicMs();
  const issues: CoreIssue[] = [];
  const assessments: EvidenceAssessment[] = [];
  let requests = 0;
  let inputTokens: number | null = 0;
  let outputTokens: number | null = 0;
  let costUsd: number | null = 0;
  let failedPairs = 0;
  const metrics = (): StageMetrics => ({
    startedAt,
    completedAt: environment.ports.clock.now(),
    durationMs: Math.max(0, environment.ports.clock.monotonicMs() - startedMs),
    externalRequests: requests,
    inputTokens,
    outputTokens,
    costUsd,
  });
  const audit = (
    kind: AuditEvent["kind"],
    message: string,
    claimId: string | null,
    snapshotId: string | null,
  ) =>
    environment.ports.audit.record({
      runId: environment.context.runId,
      stage: "assess_evidence",
      kind,
      message,
      claimId,
      snapshotId,
      at: environment.ports.clock.now(),
    });
  await audit("stage_started", "Evidence assessment started.", null, null);
  if (canceled(environment)) return canceledResult();

  const snapshotsById = new Map(input.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const admitted = [...new Set(input.admittedSnapshotIds)];
  const missing = admitted.filter((id) => !snapshotsById.has(id));
  if (missing.length > 0) {
    for (const id of missing) {
      issues.push(
        issue("citation_validation_failed", `Admitted snapshot ${id} was not supplied.`, null, id),
      );
      await audit("validation_rejected", `Unknown admitted snapshot rejected: ${id}.`, null, id);
    }
    return finish("failed", null);
  }
  const snapshots = admitted.map((id) => snapshotsById.get(id)!);
  const claims = input.claims.filter(
    (claim) =>
      claim.duplicateOfClaimId === null &&
      claim.coverageDisposition === "factual_claim" &&
      claim.checkability !== "unanswerable" &&
      claim.checkability !== "not_checkable",
  );
  if (claims.length === 0 || snapshots.length === 0) {
    const data = { assessments: [], sufficiency: buildSufficiencyFeedback(input.claims, []) };
    return finish("complete", data);
  }

  const maxRequests =
    options.maxGenerationRequests ?? environment.context.budget.maxExternalRequests;
  outer: for (const claim of claims) {
    for (const snapshot of snapshots) {
      for (const span of passageSpans(snapshot, options.maxPassagesPerSnapshot)) {
        if (canceled(environment)) return canceledResult();
        if (
          (maxRequests !== null && requests >= maxRequests) ||
          (options.deadlineMonotonicMs !== null &&
            options.deadlineMonotonicMs !== undefined &&
            environment.ports.clock.monotonicMs() >= options.deadlineMonotonicMs)
        ) {
          issues.push(
            issue(
              "budget_exhausted",
              "Assessment stopped before every claim/passage pair was processed.",
              claim.id,
              snapshot.id,
            ),
          );
          break outer;
        }
        const passage = snapshot.normalizedText.slice(span.start, span.end);
        requests += 1;
        await audit(
          "external_request",
          "Structured entailment assessment requested.",
          claim.id,
          snapshot.id,
        );
        try {
          const response = await environment.ports.generation.generate(
            buildAssessmentRequest(claim, snapshot, passage, environment.signal),
          );
          inputTokens = addUsage(inputTokens, response.usage.inputTokens);
          outputTokens = addUsage(outputTokens, response.usage.outputTokens);
          costUsd = addUsage(costUsd, response.usage.costUsd);
          const assessment = validateAssessment(response.value, claim, snapshot, span, {
            model: environment.ports.generation.modelId,
            engineVersion: environment.context.versions.engine,
          });
          if (assessment === null) {
            issues.push(
              issue(
                "citation_validation_failed",
                "A generated assessment used an invalid ID or invented/ambiguous excerpt and was rejected.",
                claim.id,
                snapshot.id,
              ),
            );
            await audit(
              "validation_rejected",
              "Invalid assessment reference or excerpt rejected before it could enter the evidence set.",
              claim.id,
              snapshot.id,
            );
          } else {
            assessments.push(assessment);
          }
          if (assessment?.validationStatus === "rejected") {
            issues.push(
              issue(
                "citation_validation_failed",
                "A generated assessment failed mechanical citation or scope validation.",
                claim.id,
                snapshot.id,
              ),
            );
            await audit(
              "validation_rejected",
              "Generated assessment rejected; it was retained as rejected audit evidence.",
              claim.id,
              snapshot.id,
            );
          }
        } catch (error) {
          if (canceled(environment)) return canceledResult();
          failedPairs += 1;
          inputTokens = outputTokens = costUsd = null;
          issues.push(
            issue(
              "provider_failure",
              error instanceof Error
                ? `Assessment provider failed: ${error.message}`
                : "Assessment provider failed.",
              claim.id,
              snapshot.id,
            ),
          );
        }
      }
    }
  }

  const dependent = assignSourceDependence(assessments, snapshots);
  const data: AssessEvidenceV2Data = {
    assessments: dependent,
    sufficiency: buildSufficiencyFeedback(input.claims, dependent),
  };
  if (assessments.length === 0 && failedPairs > 0) return finish("failed", null);
  const status = issues.some(({ severity }) => severity !== "info") ? "partial" : "complete";
  return finish(status, data);

  async function canceledResult() {
    issues.push(issue("cancellation_requested", "Evidence assessment was canceled."));
    await audit("cancellation", "Evidence assessment canceled.", null, null);
    return finish("failed", null);
  }

  async function finish(
    status: "complete" | "partial" | "unavailable" | "failed",
    data: AssessEvidenceV2Data | null,
  ) {
    await audit(
      "stage_finished",
      `Evidence assessment finished with status ${status}.`,
      null,
      null,
    );
    if (status === "complete" || status === "partial")
      return { status, data: data!, issues, metrics: metrics() };
    return { status, data: null, issues, metrics: metrics() };
  }
}

function passageSpans(snapshot: DocumentSnapshot, limit?: number) {
  const spans =
    snapshot.locators.length > 0
      ? snapshot.locators.map(({ span }) => span)
      : [{ start: 0, end: snapshot.normalizedText.length }];
  const unique = [...new Map(spans.map((span) => [`${span.start}:${span.end}`, span])).values()]
    .filter(
      (span) =>
        span.start < span.end && snapshot.normalizedText.slice(span.start, span.end).trim() !== "",
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
  return limit === undefined ? unique : unique.slice(0, limit);
}

function addUsage(total: number | null, value: number | null) {
  return total === null || value === null ? null : total + value;
}

function canceled(environment: RunEnvironment) {
  return environment.signal.aborted || environment.context.cancellation.requested;
}

function issue(
  code: CoreIssue["code"],
  message: string,
  claimId: string | null = null,
  snapshotId: string | null = null,
): CoreIssue {
  return { code, severity: "warning", message, claimId, snapshotId, url: null };
}
