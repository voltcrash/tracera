import { Queue, Worker } from "bullmq";
import { dueChecks, pool } from "@repo/db";

const connection = { url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379" };
const queue = new Queue("tracera-decay", { connection });
await queue.upsertJobScheduler("decay-sweep", { every: Number(process.env.DECAY_SWEEP_MS ?? 3_600_000) }, { name: "sweep" });
const workerToken = process.env.INTERNAL_WORKER_TOKEN;
if (!workerToken) throw new Error("INTERNAL_WORKER_TOKEN is required for the decay worker.");

new Worker("tracera-decay", async (job) => {
  if (job.name !== "sweep") return;
  for (const check of await dueChecks()) {
    try {
      const response = await fetch(`${process.env.INTERNAL_API_URL ?? "http://127.0.0.1:3001"}/analyze`, {
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
      await pool.query("UPDATE checks SET next_review_at = NOW() + INTERVAL '24 hours' WHERE id=$1", [check.id]);
    } catch (error) { console.error("Decay recheck failed", check.id, error); }
  }
}, { connection });

console.log("Tracera decay monitor started");
