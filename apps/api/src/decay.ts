import {
  activeAlertEmailsForTrace,
  dueChecks,
  getDecayCheckById,
  markAlertSubscriptionsNotified,
  pool,
  recordDecayEvent,
} from "@repo/db";
import { Redis } from "@upstash/redis";
import type { Bindings } from "./index.js";

type DueCheck = NonNullable<Awaited<ReturnType<typeof getDecayCheckById>>>;
type DecayJob = { checkId: string; attempts: number };
const DECAY_QUEUE = "tracera:decay:ready";
const DECAY_PROCESSING = "tracera:decay:processing";
const DECAY_DEAD_LETTER = "tracera:decay:dead-letter";
const DECAY_SWEEP_LOCK = "tracera:decay:sweep-lock";

/**
 * Cloudflare Cron Triggers invoke this once per hour. Upstash lists provide a
 * durable ready/processing queue because BullMQ requires a persistent TCP
 * worker, which is not available in the Workers runtime.
 */
export async function runDecaySweep(env: Bindings) {
  const checks = await dueChecks();
  const redis = decayRedis(env);
  if (!redis) {
    await Promise.allSettled(checks.map((check) => recheck(check, env)));
    return;
  }

  const lockToken = crypto.randomUUID();
  const locked = await redis.set(DECAY_SWEEP_LOCK, lockToken, {
    nx: true,
    ex: 55 * 60,
  });
  if (locked !== "OK") return;

  try {
    await recoverInterruptedJobs(redis);
    for (const check of checks) {
      const jobKey = decayJobKey(check.id);
      const queued = await redis.set(jobKey, "queued", {
        nx: true,
        ex: 6 * 60 * 60,
      });
      if (queued !== "OK") continue;
      await redis.lpush(DECAY_QUEUE, {
        checkId: check.id,
        attempts: 0,
      } satisfies DecayJob);
      await recordDecayEvent({ checkId: check.id, eventType: "scheduled" });
    }

    const jobsToProcess = Math.min(await redis.llen(DECAY_QUEUE), 25);
    for (let index = 0; index < jobsToProcess; index += 1) {
      const job = await redis.lmove<DecayJob>(DECAY_QUEUE, DECAY_PROCESSING, "right", "left");
      if (!job) break;
      try {
        const check = await getDecayCheckById(job.checkId);
        if (check) await recheck(check, env);
        await Promise.all([
          redis.lrem(DECAY_PROCESSING, 1, job),
          redis.del(decayJobKey(job.checkId)),
        ]);
      } catch {
        await redis.lrem(DECAY_PROCESSING, 1, job);
        if (job.attempts >= 2) {
          await pool.query(
            "UPDATE checks SET next_review_at = NOW() + INTERVAL '7 days' WHERE id = $1",
            [job.checkId],
          );
          await Promise.all([
            redis.lpush(DECAY_DEAD_LETTER, {
              ...job,
              attempts: job.attempts + 1,
            }),
            redis.del(decayJobKey(job.checkId)),
          ]);
        } else {
          await redis.lpush(DECAY_QUEUE, {
            ...job,
            attempts: job.attempts + 1,
          });
        }
      }
    }
  } finally {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      [DECAY_SWEEP_LOCK],
      [lockToken],
    );
  }
}

function decayRedis(env: Bindings) {
  const url = env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

async function recoverInterruptedJobs(redis: Redis) {
  while (await redis.llen(DECAY_PROCESSING)) {
    const recovered = await redis.lmove(DECAY_PROCESSING, DECAY_QUEUE, "right", "left");
    if (!recovered) break;
  }
}

function decayJobKey(checkId: string) {
  return `tracera:decay:job:${checkId}`;
}

async function recheck(check: DueCheck, env: Bindings) {
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
      check?: { id?: string; nextReviewAt?: string };
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
      await notifyTraceSubscribers(check.id, recheck.check.id, previousScore!, currentScore!, env);
      await recordDecayEvent({
        checkId: check.id,
        eventType: "changed",
        detail: { recheckId: recheck.check.id, previousScore, currentScore },
      });
    }
    // The newly persisted child owns the next adaptive review. Retire this
    // version so one trace does not accumulate multiple active schedules.
    await pool.query("UPDATE checks SET next_review_at = NULL WHERE id=$1", [check.id]);
    await recordDecayEvent({
      checkId: check.id,
      eventType: "completed",
      detail: {
        recheckId: recheck.check?.id,
        changed,
        nextReviewAt: recheck.check?.nextReviewAt,
      },
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
  return (env.INTERNAL_API_URL ?? "https://api.tracera.voltcrash.com").replace(/\/$/, "");
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
    env.PUBLIC_WEB_URL ?? process.env.PUBLIC_WEB_URL ?? "https://tracera.voltcrash.com";
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
      if (!response.ok) throw new Error(`Alert delivery failed with HTTP ${response.status}.`);
    }),
  );
  await markAlertSubscriptionsNotified(originalCheckId, newCheckId, recipients);
}
