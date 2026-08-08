import {
  activeAlertEmailsForTrace,
  dueChecks,
  markAlertSubscriptionsNotified,
  pool,
  recordDecayEvent,
} from "@repo/db";
import type { Bindings } from "./index.js";

/**
 * Cloudflare Cron Triggers invoke this once per hour. Rechecks are submitted
 * directly to the API Worker because BullMQ requires a persistent TCP worker,
 * which is not available in the Workers runtime.
 */
export async function runDecaySweep(env: Bindings) {
  const checks = await dueChecks();
  for (const check of checks) {
    await recheck(check, env);
  }
}

async function recheck(
  check: Awaited<ReturnType<typeof dueChecks>>[number],
  env: Bindings,
) {
  await recordDecayEvent({ checkId: check.id, eventType: "started" });
  try {
    const apiUrl = requiredApiUrl(env);
    const workerToken = requiredWorkerToken(env);
    const response = await fetch(`${apiUrl}/analyze`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tracera-worker-token": workerToken,
      },
      body: JSON.stringify(
        check.input_type === "link"
          ? { url: check.source_url ?? check.raw_input, recheckOf: check.id }
          : { text: check.raw_input, recheckOf: check.id },
      ),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const recheck = (await response.json()) as {
      check?: { id?: string };
      traceraScore?: { overall?: number };
    };
    const previousScore = scoreFromStoredAnalysis(check.analysis);
    const currentScore = recheck.traceraScore?.overall;
    const changed = Boolean(
      recheck.check?.id &&
        typeof previousScore === "number" &&
        typeof currentScore === "number" &&
        Math.abs(currentScore - previousScore) >= alertScoreDelta(env),
    );
    if (changed && recheck.check?.id) {
      await notifyTraceSubscribers(
        check.id,
        recheck.check.id,
        previousScore!,
        currentScore!,
        env,
      );
      await recordDecayEvent({
        checkId: check.id,
        eventType: "changed",
        detail: { recheckId: recheck.check.id, previousScore, currentScore },
      });
    }
    await pool.query(
      "UPDATE checks SET next_review_at = NOW() + INTERVAL '24 hours' WHERE id=$1",
      [check.id],
    );
    await recordDecayEvent({
      checkId: check.id,
      eventType: "completed",
      detail: { recheckId: recheck.check?.id, changed },
    });
  } catch (error) {
    await recordDecayEvent({
      checkId: check.id,
      eventType: "failed",
      detail: {
        message: error instanceof Error ? error.message : "Unknown error",
      },
    });
    throw error;
  }
}

function requiredApiUrl(env: Bindings) {
  const value = env.INTERNAL_API_URL ?? process.env.INTERNAL_API_URL;
  if (!value) throw new Error("INTERNAL_API_URL is required for decay checks.");
  return value.replace(/\/$/, "");
}

function requiredWorkerToken(env: Bindings) {
  const value = env.INTERNAL_WORKER_TOKEN ?? process.env.INTERNAL_WORKER_TOKEN;
  if (!value) throw new Error("INTERNAL_WORKER_TOKEN is required for decay checks.");
  return value;
}

function scoreFromStoredAnalysis(analysis: unknown) {
  if (!analysis || typeof analysis !== "object") return undefined;
  const score = (analysis as { score?: { overall?: unknown } }).score?.overall;
  return typeof score === "number" ? score : undefined;
}

function alertScoreDelta(env: Bindings) {
  const configured = Number(env.ALERT_SCORE_DELTA ?? process.env.ALERT_SCORE_DELTA ?? 5);
  return Number.isFinite(configured) && configured >= 0 ? configured : 5;
}

async function notifyTraceSubscribers(
  originalCheckId: string,
  newCheckId: string,
  previousScore: number,
  currentScore: number,
  env: Bindings,
) {
  const recipients = await activeAlertEmailsForTrace(originalCheckId);
  if (!recipients.length) return;
  const apiKey = env.RESEND_API_KEY ?? process.env.RESEND_API_KEY;
  const from = env.ALERT_FROM_EMAIL ?? process.env.ALERT_FROM_EMAIL;
  if (!apiKey || !from) {
    console.warn("Trace changed but alert delivery is not configured", {
      originalCheckId,
      recipients: recipients.length,
    });
    return;
  }
  const change = Math.round(currentScore - previousScore);
  const webUrl =
    env.PUBLIC_WEB_URL ?? process.env.PUBLIC_WEB_URL ?? "http://localhost:3000";
  const link = `${webUrl.replace(/\/$/, "")}/hub/${newCheckId}`;
  await Promise.all(
    recipients.map(async (to) => {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject: `Tracera update: score ${change >= 0 ? "rose" : "fell"} by ${Math.abs(change)} points`,
          text: `New evidence changed this trace from ${previousScore}/100 to ${currentScore}/100. Review the updated evidence: ${link}`,
        }),
      });
      if (!response.ok)
        throw new Error(`Alert delivery failed with HTTP ${response.status}.`);
    }),
  );
  await markAlertSubscriptionsNotified(originalCheckId, newCheckId, recipients);
}
