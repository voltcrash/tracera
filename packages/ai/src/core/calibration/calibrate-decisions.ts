import {
  decisionSchema,
  type Calibration,
  type CoreIssue,
  type Decision,
  type DecisionReasonCode,
  type StageResult,
} from "@repo/contracts/core-v2";
import { isDecisive } from "../adjudication/policy.js";
import type {
  AuditEvent,
  CalibrateDecisionsV2,
  CalibrateDecisionsV2Data,
  RunEnvironment,
} from "../types.js";
import { checkCalibratorArtifact, findSlice, predictCorrectness } from "./artifact.js";
import { CalibrationFeatureError, extractCalibrationFeatures } from "./features.js";

export interface CalibrationOptions {
  /** Parsed JSON of a frozen calibrator artifact, or null when none is installed. */
  artifact: unknown;
}

const CALIBRATION_REASONS = new Set<DecisionReasonCode>([
  "calibration_unavailable",
  "calibration_out_of_scope",
]);

export function createCalibrateDecisionsV2(options: CalibrationOptions): CalibrateDecisionsV2 {
  return async (input, environment) => calibrate(input, environment, options);
}

async function calibrate(
  input: Parameters<CalibrateDecisionsV2>[0],
  environment: RunEnvironment,
  options: CalibrationOptions,
): Promise<StageResult<CalibrateDecisionsV2Data>> {
  const { clock } = environment.ports;
  const startedAt = clock.now();
  const startedMs = clock.monotonicMs();
  const issues: CoreIssue[] = [];
  const decisions: Decision[] = [];
  await audit("stage_started", "Decision calibration started.", null);
  if (canceled()) return canceledResult();

  const check = checkCalibratorArtifact(options.artifact, environment.context, clock.now());
  if (check.status !== "valid") {
    const gatesDecisiveOutput = input.decisions.some(({ diagnosticLabel }) =>
      isDecisive(diagnosticLabel),
    );
    issues.push(
      issue(
        "calibration_unavailable",
        check.reason,
        null,
        check.status === "invalidated" || gatesDecisiveOutput ? "warning" : "info",
      ),
    );
  }
  const claims = new Map(input.claims.map((claim) => [claim.id, claim]));
  const languages = new Map<string, string | null>();
  if (check.status === "valid") {
    try {
      const ids = [...new Set(input.claims.map(({ documentId }) => documentId))].sort();
      for (const snapshot of await environment.ports.snapshots.getMany(ids, environment.signal))
        languages.set(snapshot.id, snapshot.language);
    } catch (error) {
      if (canceled()) return canceledResult();
      issues.push(
        issue(
          "snapshot_unavailable",
          `Claim languages could not be read, so no calibration slice can apply: ${error instanceof Error ? error.message : "unknown error"}`,
        ),
      );
    }
  }

  let omitted = 0;
  for (const raw of input.decisions) {
    if (canceled()) return canceledResult();
    const parsed = decisionSchema.safeParse(raw);
    const claim = parsed.success ? claims.get(parsed.data.claimId) : undefined;
    if (!parsed.success || claim === undefined) {
      omitted += 1;
      issues.push(
        issue(
          "citation_validation_failed",
          "An adjudicated decision was malformed or referenced an unknown claim.",
          raw.claimId,
        ),
      );
      continue;
    }
    const decision = parsed.data;
    const reasons = decision.reasonCodes.filter((code) => !CALIBRATION_REASONS.has(code));
    const citationIntegrity = citationsResolve(decision) ? decision.citationIntegrity : "invalid";
    if (citationIntegrity === "invalid" && decision.citationIntegrity !== "invalid") {
      reasons.push("citation_validation_failed");
      issues.push(
        issue(
          "citation_validation_failed",
          "A decision cited assessments that are not validated for its claim.",
          claim.id,
        ),
      );
    }

    let calibration: Calibration;
    let publishable = false;
    if (check.status !== "valid") {
      calibration = {
        applicability: check.status,
        calibratedCorrectness: null,
        calibratorVersion: check.calibratorVersion,
        reason: check.reason,
      };
      if (isDecisive(decision.diagnosticLabel)) reasons.push("calibration_unavailable");
    } else {
      const slice = findSlice(
        check.artifact,
        languages.get(claim.documentId) ?? null,
        decision.diagnosticLabel,
      );
      let probability: number | null = null;
      if (slice !== undefined && citationIntegrity === "valid") {
        try {
          probability = predictCorrectness(
            check.artifact,
            extractCalibrationFeatures(decision, input.assessments),
          );
        } catch (error) {
          if (!(error instanceof CalibrationFeatureError)) throw error;
          issues.push(issue("citation_validation_failed", error.message, claim.id));
        }
      }
      if (slice === undefined || probability === null) {
        calibration = {
          applicability: "out_of_scope",
          calibratedCorrectness: null,
          calibratorVersion: check.artifact.calibratorVersion,
          reason: isDecisive(decision.diagnosticLabel)
            ? "The decision is outside every validated calibration slice."
            : "Correctness calibration covers decisive labels only.",
        };
        if (isDecisive(decision.diagnosticLabel)) reasons.push("calibration_out_of_scope");
      } else {
        calibration = {
          applicability: "in_scope",
          calibratedCorrectness: probability,
          calibratorVersion: check.artifact.calibratorVersion,
          sliceId: slice.sliceId,
        };
        const meetsThreshold = slice.threshold !== null && probability >= slice.threshold;
        publishable =
          meetsThreshold &&
          decision.challenge.status === "resolved" &&
          citationIntegrity === "valid";
        if (!meetsThreshold) {
          // The frozen reason codes have no below-threshold member; out-of-scope is the closest release gate.
          reasons.push("calibration_out_of_scope");
          issues.push(
            issue(
              "calibration_unavailable",
              slice.threshold === null
                ? `Slice ${slice.sliceId} has no frozen release threshold.`
                : `Calibrated correctness is below the frozen ${slice.sliceId} release threshold.`,
              claim.id,
              "info",
            ),
          );
        }
      }
    }

    const decisive = isDecisive(decision.diagnosticLabel);
    const publishedLabel = decisive
      ? publishable
        ? decision.diagnosticLabel
        : "unverified"
      : decision.diagnosticLabel;
    if (decisive && !publishable)
      await audit(
        "decision_gated",
        `Decisive ${decision.diagnosticLabel} diagnostic was published as unverified.`,
        claim.id,
      );
    decisions.push(
      decisionSchema.parse({
        ...decision,
        publishedLabel,
        reasonCodes: [...new Set(reasons)],
        calibration,
        citationIntegrity,
      }),
    );
  }

  const status =
    omitted > 0 || issues.some(({ severity }) => severity !== "info") ? "partial" : "complete";
  return finish(status, { decisions });

  function citationsResolve(decision: Decision) {
    const byId = new Map(input.assessments.map((assessment) => [assessment.id, assessment]));
    return [
      ...decision.supportingAssessmentIds,
      ...decision.contradictingAssessmentIds,
      ...decision.correctiveContextAssessmentIds,
    ].every((id) => {
      const assessment = byId.get(id);
      return (
        assessment?.claimId === decision.claimId && assessment.validationStatus === "validated"
      );
    });
  }

  function canceled() {
    return environment.signal.aborted || environment.context.cancellation.requested;
  }

  async function canceledResult() {
    issues.push(issue("cancellation_requested", "Decision calibration was canceled."));
    await audit(
      "cancellation",
      "Decision calibration canceled; no partial decisions were returned.",
      null,
    );
    return finish("failed", null);
  }

  function audit(kind: AuditEvent["kind"], message: string, claimId: string | null) {
    return environment.ports.audit.record({
      runId: environment.context.runId,
      stage: "calibrate_decisions",
      kind,
      message,
      claimId,
      snapshotId: null,
      at: clock.now(),
    });
  }

  async function finish(
    status: StageResult<CalibrateDecisionsV2Data>["status"],
    data: CalibrateDecisionsV2Data | null,
  ): Promise<StageResult<CalibrateDecisionsV2Data>> {
    await audit("stage_finished", `Decision calibration finished with status ${status}.`, null);
    return {
      status,
      data,
      issues,
      metrics: {
        startedAt,
        completedAt: clock.now(),
        durationMs: Math.max(0, clock.monotonicMs() - startedMs),
        externalRequests: 0,
        inputTokens: null,
        outputTokens: null,
        costUsd: 0,
      },
    };
  }
}

function issue(
  code: CoreIssue["code"],
  message: string,
  claimId: string | null = null,
  severity: CoreIssue["severity"] = "warning",
): CoreIssue {
  return { code, severity, message, claimId, snapshotId: null, url: null };
}
