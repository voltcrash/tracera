import { expect, test, vi } from "vite-plus/test";
import { Composer, type ComposerImage } from "../src/lib/composer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const image = (name: string): ComposerImage => ({
  name,
  bytes: 1,
  dataUrl: name,
  mimeType: "image/png",
});
const accepted = { status: 202, body: { runId: "run_accepted" } };

test("synchronous duplicate submits share one physical request and uncertain retries retain its identity", async () => {
  const composer = new Composer();
  composer.edit("The library opened in 2026.");
  const pending = deferred<typeof accepted>();
  const start = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(accepted);
  const open = vi.fn().mockResolvedValue(undefined);
  const first = composer.submit("ada", start, open);
  await composer.submit("ada", start, open);
  expect(start).toHaveBeenCalledTimes(1);
  pending.resolve({ status: 503, body: { runId: "" } });
  await first;
  expect(composer.getSnapshot().submission.status).toBe("failed");
  await composer.submit("ada", start, open);
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls[1]).toEqual(start.mock.calls[0]);
  expect(open).toHaveBeenCalledOnce();
  await composer.submit("ada", start, open);
  expect(start).toHaveBeenCalledTimes(2);
});

test("changed effective inputs and owners receive distinct request identities", async () => {
  const composer = new Composer();
  const start = vi.fn().mockRejectedValue(new Error("Response lost"));
  const open = vi.fn();
  composer.edit("First claim");
  await composer.submit("ada", start, open);
  composer.edit("  First claim  ");
  await composer.submit("ada", start, open);
  composer.edit("Second claim");
  await composer.submit("ada", start, open);
  await composer.submit("grace", start, open);
  const keys = start.mock.calls.map(([options]) => options.data.idempotencyKey);
  expect(keys[1]).toBe(keys[0]);
  expect(new Set(keys).size).toBe(3);
});

test("a confirmed persistence failure permits a fresh attempt instead of replaying its cached failure", async () => {
  const composer = new Composer();
  composer.edit("A claim");
  const start = vi
    .fn()
    .mockResolvedValueOnce({
      status: 503,
      body: { code: "analysis_start_failed", status: "failed", error: "Please try again." },
    })
    .mockResolvedValue(accepted);
  const open = vi.fn().mockResolvedValue(undefined);
  await composer.submit("ada", start, open);
  await composer.submit("ada", start, open);
  expect(start.mock.calls[1]![0].data.idempotencyKey).not.toBe(
    start.mock.calls[0]![0].data.idempotencyKey,
  );
  expect(open).toHaveBeenCalledWith("run_accepted");
});

test("navigation failure retains acceptance and reopening never resubmits", async () => {
  const composer = new Composer();
  composer.edit("https://news.example/library");
  const start = vi.fn().mockResolvedValue(accepted);
  const open = vi
    .fn()
    .mockRejectedValueOnce(new Error("Route unavailable"))
    .mockResolvedValue(undefined);
  await composer.submit("ada", start, open);
  expect(composer.getSnapshot().submission).toMatchObject({
    status: "accepted",
    runId: "run_accepted",
    error: expect.stringContaining("saved"),
  });
  composer.edit("Another claim");
  expect(composer.getSnapshot().text).toBe("https://news.example/library");
  await composer.openRun(open);
  expect(start).toHaveBeenCalledOnce();
  expect(open.mock.calls).toEqual([["run_accepted"], ["run_accepted"]]);
  expect(composer.getSnapshot().submission).toEqual({ status: "accepted", runId: "run_accepted" });
});

test("attachment reads block submission and ignore stale successes, errors and removal completions", async () => {
  const composer = new Composer();
  composer.edit("Preserved text");
  const old = deferred<{ error: string }>();
  const latest = deferred<{ image: ComposerImage }>();
  const first = composer.attach(() => old.promise);
  const second = composer.attach(() => latest.promise);
  const start = vi.fn();
  await composer.submit("ada", start, vi.fn());
  expect(start).not.toHaveBeenCalled();
  latest.resolve({ image: image("latest") });
  await second;
  old.resolve({ error: "Old failure" });
  await first;
  expect(composer.getSnapshot()).toMatchObject({ image: image("latest"), attachmentError: null });
  const removed = deferred<{ image: ComposerImage }>();
  const pending = composer.attach(() => removed.promise);
  composer.removeImage();
  removed.resolve({ image: image("removed") });
  await pending;
  expect(composer.getSnapshot()).toMatchObject({
    text: "Preserved text",
    image: null,
    attachment: "idle",
  });
});

test("leaving the composer prevents a late acceptance from navigating back", async () => {
  const composer = new Composer();
  composer.edit("A claim");
  const pending = deferred<typeof accepted>();
  const open = vi.fn();
  const submit = composer.submit("ada", () => pending.promise, open);
  composer.cancelPending();
  pending.resolve(accepted);
  await submit;
  expect(open).not.toHaveBeenCalled();
});
