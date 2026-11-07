import { expect, test, vi } from "vite-plus/test";
import { AsyncResource } from "../src/lib/async-resource";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("failed loads preserve cached data and distinguish unknown from a confirmed empty result", async () => {
  const resource = new AsyncResource<string[]>("ada");
  const fail = () => Promise.reject(new Error("Unavailable"));
  expect(await resource.refresh(fail)).toBe(false);
  expect(resource.getSnapshot()).toEqual({ status: "error", data: null });
  await resource.refresh(fail, ["cached"]);
  expect(resource.getSnapshot()).toEqual({ status: "error", data: ["cached"] });
  const pending = deferred<string[]>();
  const retry = resource.refresh(() => pending.promise);
  expect(resource.getSnapshot()).toEqual({ status: "loading", data: ["cached"] });
  pending.resolve([]);
  expect(await retry).toBe(true);
  expect(resource.getSnapshot()).toEqual({ status: "ready", data: [] });
});

test("superseded successes and failures cannot overwrite a newer read or its cache", async () => {
  const resource = new AsyncResource<string>("ada");
  const first = deferred<string>();
  const second = deferred<string>();
  const commit = vi.fn();
  const oldSuccess = resource.refresh(() => first.promise, null, commit);
  const oldFailure = resource.refresh(() => second.promise, null, commit);
  await resource.refresh(() => Promise.resolve("new"), null, commit);
  first.resolve("old");
  second.reject(new Error("Old error"));
  await Promise.all([oldSuccess, oldFailure]);
  expect(resource.getSnapshot()).toEqual({ status: "ready", data: "new" });
  expect(commit.mock.calls).toEqual([["new"]]);
});

test("canceling on unmount prevents late storage writes and a later refresh can still finish", async () => {
  const resource = new AsyncResource<string>("ada");
  const pending = deferred<string>();
  const commit = vi.fn();
  const old = resource.refresh(() => pending.promise, null, commit);
  resource.cancel();
  const inactiveLoad = vi.fn();
  expect(await resource.refresh(inactiveLoad)).toBe(false);
  expect(inactiveLoad).not.toHaveBeenCalled();
  resource.activate();
  await resource.refresh(() => Promise.resolve("fresh"), null, commit);
  pending.resolve("unmounted");
  expect(await old).toBe(false);
  expect(commit.mock.calls).toEqual([["fresh"]]);
  expect(resource.getSnapshot()).toEqual({ status: "ready", data: "fresh" });
});
