import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import { startAnalysisRun } from "../src/server/analysis-api.server";
import {
  evidenceResponse,
  healthResponse,
  runEventsResponse,
} from "../src/server/api-routes.server";
import { SERVICE_UNAVAILABLE_MESSAGE } from "../src/server/error-handling";
import { createWorkerTestEnv, ORIGIN, seedFinishedRun, signIn } from "./support/worker-env";

let harness: Awaited<ReturnType<typeof createWorkerTestEnv>>;
let ada: Awaited<ReturnType<typeof signIn>>;
let grace: Awaited<ReturnType<typeof signIn>>;
beforeAll(async () => {
  harness = await createWorkerTestEnv();
  ada = await signIn(harness.env, "ada");
  grace = await signIn(harness.env, "grace");
});
afterAll(async () => {
  await harness?.dispose();
});

const as = (who: { cookie: string } | null, path: string) =>
  new Request(`${ORIGIN}${path}`, { headers: who ? { cookie: who.cookie } : {} });

test("finished runs stream one progress event with the report, then close", async () => {
  const report = await seedFinishedRun(harness.env, ada.user.id, crypto.randomUUID());
  const response = await runEventsResponse(
    harness.env,
    as(ada, `/api/runs/${report.runId}/events`),
    report.runId,
  );
  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  const body = await response.text();
  expect(body.startsWith("retry: 2000\n\n")).toBe(true);
  const events = body.split("\n\n").filter((event) => event.includes("event: progress"));
  expect(events).toHaveLength(1);
  const data = JSON.parse(events[0]!.split("data: ")[1]!);
  expect(data).toMatchObject({ schemaVersion: 2, progress: { status: "complete" } });
  expect(data.report.runId).toBe(report.runId);
});

test("live runs stream their current progress until the reader disconnects", async () => {
  const started = await startAnalysisRun({
    env: harness.env,
    user: ada.user,
    request: new Request(ORIGIN),
    body: { text: "A queued claim." },
    idempotencyKey: crypto.randomUUID(),
  });
  const runId = started.body.runId as string;
  const response = await runEventsResponse(
    harness.env,
    as(ada, `/api/runs/${runId}/events`),
    runId,
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("event: progress")) text += decoder.decode((await reader.read()).value);
  expect(text).toContain('"status":"queued"');
  await reader.cancel();
});

test("progress streams require the owner's session", async () => {
  const report = await seedFinishedRun(harness.env, ada.user.id, crypto.randomUUID());
  const path = `/api/runs/${report.runId}/events`;
  expect((await runEventsResponse(harness.env, as(null, path), report.runId)).status).toBe(401);
  expect((await runEventsResponse(harness.env, as(grace, path), report.runId)).status).toBe(404);
});

test("evidence returns a snapshot and a validated excerpt to the owner only", async () => {
  const report = await seedFinishedRun(harness.env, ada.user.id, crypto.randomUUID());
  const snapshot = report.snapshots[0]!;
  const path = (query = "") => `/api/runs/${report.runId}/evidence/${snapshot.id}${query}`;
  const evidence = (who: typeof ada | null, query = "", snapshotId = snapshot.id) =>
    evidenceResponse(harness.env, as(who, path(query)), report.runId, snapshotId);

  const prepare = vi.fn((sql: string) => harness.env.DB.prepare(sql));
  const full = await evidenceResponse(
    { ...harness.env, DB: { prepare } as unknown as D1Database },
    as(ada, path()),
    report.runId,
    snapshot.id,
  );
  expect(prepare.mock.calls.filter(([sql]) => sql.includes("core_snapshots"))).toHaveLength(0);
  expect(prepare.mock.calls.filter(([sql]) => sql.includes("core_report_versions"))).toHaveLength(
    1,
  );
  expect(full.status).toBe(200);
  expect(await full.json()).toMatchObject({
    schemaVersion: 2,
    snapshot: { id: snapshot.id },
    excerpt: null,
  });
  const excerpt = (await (await evidence(ada, "?start=0&end=5")).json()) as {
    excerpt: { quote: string };
  };
  expect(excerpt.excerpt.quote).toBe(snapshot.normalizedText.slice(0, 5));
  expect((await evidence(ada, "?start=5&end=5")).status).toBe(400);
  expect((await evidence(ada, "", "missing-snapshot")).status).toBe(404);
  expect((await evidence(grace)).status).toBe(404);
  expect((await evidence(null)).status).toBe(401);
});

test("health reports the D1 connection", async () => {
  expect(
    await (await healthResponse(harness.env, new Request(`${ORIGIN}/api/health`))).json(),
  ).toEqual({ status: "ok", services: { database: "connected" } });
});

test("an unavailable database gives a generic 503 with the request ID", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const broken = {
    ...harness.env,
    DB: {
      prepare: () => {
        throw new Error("d1://admin:secret@internal failed");
      },
    } as unknown as D1Database,
  };
  const response = await healthResponse(
    broken,
    new Request(`${ORIGIN}/api/health`, { headers: { "x-request-id": "support-42" } }),
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("x-request-id")).toBe("support-42");
  expect(await response.json()).toEqual({
    status: "error",
    message: SERVICE_UNAVAILABLE_MESSAGE,
    requestId: "support-42",
  });
  expect(JSON.stringify(error.mock.calls)).not.toContain("secret");
  error.mockRestore();
});
