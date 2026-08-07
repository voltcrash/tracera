import { checkDatabase } from "@repo/db";
import { createClient } from "redis";

export const dynamic = "force-dynamic";

const redis = createClient({
  url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
});

async function checkRedis() {
  if (!redis.isOpen) {
    await redis.connect();
  }

  return redis.ping();
}

export async function GET() {
  try {
    const [database, cache] = await Promise.all([checkDatabase(), checkRedis()]);

    return Response.json({ status: "ok", services: { database, cache } });
  } catch (error) {
    return Response.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : "Health check failed",
      },
      { status: 503 },
    );
  }
}
