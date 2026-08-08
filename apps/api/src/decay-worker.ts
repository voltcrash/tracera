import { Queue, Worker } from "bullmq";
import {
  activeAlertEmailsForTrace,
  dueChecks,
  markAlertSubscriptionsNotified,
  pool,
  recordDecayEvent,
} from "@repo/db";

const connection = { url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379" };
const queue = new Queue("tracera-decay", { connection });
await queue.upsertJobScheduler(
  "decay-sweep",
  { every: Number(process.env.DECAY_SWEEP_MS ?? 3_600_000) },
  { name: "sweep" },
);
const configuredWorkerToken = process.env.INTERNAL_WORKER_TOKEN;
if (!configuredWorkerToken)
  throw new Error("INTERNAL_WORKER_TOKEN is required for the decay worker.");
const workerToken: string = configuredWorkerToken;

new Worker(
  "tracera-decay",
  async (job) => {
    if (job.name === "sweep") return scheduleDueChecks();
    if (job.name === "recheck") return recheck(job.data.check);
  },
  {
    connection,
    concurrency: Number(process.env.DECAY_WORKER_CONCURRENCY ?? 2),
  },
);

console.log("Tracera decay monitor started");

async function scheduleDueChecks() {
  const checks = await dueChecks();
  for (const check of checks) {
    const jobId = `recheck:${check.id}:${new Date(check.next_review_at).getTime()}`;
    const existing = await queue.getJob(jobId);
    if (existing) {
      if (await existing.isFailed()) {
        await existing.retry();
        await recordDecayEvent({
          checkId: check.id,
          eventType: "scheduled",
          detail: { jobId, retriedFailedJob: true },
        });
      }
      continue;
    }
    await queue.add(
      "recheck",
      { check },
      {
        jobId,
        attempts: Number(process.env.DECAY_RECHECK_ATTEMPTS ?? 5),
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 250,
        removeOnFail: false,
      },
    );
    await recordDecayEvent({
      checkId: check.id,
      eventType: "scheduled",
      detail: { jobId },
    });
  }
}

async function recheck(check: Awaited<ReturnType<typeof dueChecks>>[number]) {
  await recordDecayEvent({ checkId: check.id, eventType: "started" });
  try {
    const response = await fetch(
      `${process.env.INTERNAL_API_URL ?? "http://127.0.0.1:3001"}/analyze`,
      {
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
      },
    );
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
      Math.abs(currentScore - previousScore) >= alertScoreDelta(),
    );
    if (changed && recheck.check?.id) {
      await notifyTraceSubscribers(
        check.id,
        recheck.check.id,
        previousScore!,
        currentScore!,
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

function scoreFromStoredAnalysis(analysis: unknown) {
  if (!analysis || typeof analysis !== "object") return undefined;
  const score = (analysis as { score?: { overall?: unknown } }).score?.overall;
  return typeof score === "number" ? score : undefined;
}
function alertScoreDelta() {
  const configured = Number(process.env.ALERT_SCORE_DELTA ?? 5);
  return Number.isFinite(configured) && configured >= 0 ? configured : 5;
}
async function notifyTraceSubscribers(
  originalCheckId: string,
  newCheckId: string,
  previousScore: number,
  currentScore: number,
) {
  const recipients = await activeAlertEmailsForTrace(originalCheckId);
  if (!recipients.length) return;
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_FROM_EMAIL;
  if (!apiKey || !from) {
    console.warn("Trace changed but alert delivery is not configured", {
      originalCheckId,
      recipients: recipients.length,
    });
    return;
  }
  const change = Math.round(currentScore - previousScore);
  const link = `${(process.env.PUBLIC_WEB_URL ?? "http://localhost:3000").replace(/\/$/, "")}/hub/${newCheckId}`;
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
