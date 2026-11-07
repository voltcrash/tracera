import { expect, test, vi } from "vite-plus/test";
import { authPhase, startSocialSignIn, type AuthUser } from "../src/lib/auth-state";
import { ProfileEditor } from "../src/lib/profile-editor";

const ada: AuthUser = {
  id: "ada",
  name: "Ada",
  email: "ada@example.test",
  image: "old",
  createdAt: "2026-11-07T00:00:00Z",
};
const grace: AuthUser = { ...ada, id: "grace", name: "Grace", email: "grace@example.test" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("unknown sessions remain errors and only explicit unauthorized/empty responses are anonymous", () => {
  const session = { isPending: false, isRefetching: false, user: null, error: null };
  expect(authPhase({ ...session, error: { status: 503 } })).toBe("error");
  expect(authPhase({ ...session, error: { status: 401 } })).toBe("anonymous");
  expect(authPhase(session)).toBe("anonymous");
  expect(authPhase({ ...session, user: ada, isRefetching: true }, true)).toBe("pending");
  expect(authPhase({ ...session, user: ada })).toBe("authenticated");
});

test("thrown and returned sign-in failures are recoverable; successful requests await redirect", async () => {
  expect(
    await startSocialSignIn(async () => {
      throw new Error("Network failed");
    }, "GitHub"),
  ).toMatchObject({ status: "failed", error: expect.stringContaining("try again") });
  expect(await startSocialSignIn(async () => ({ error: { message: "Denied" } }), "GitHub")).toEqual(
    { status: "failed", error: "Denied" },
  );
  expect(await startSocialSignIn(async () => ({}), "GitHub")).toEqual({ status: "redirecting" });
});

test("a pending avatar write suppresses another physical write through session refresh", async () => {
  const refresh = deferred();
  const persist = vi.fn().mockResolvedValue(undefined);
  const editor = new ProfileEditor({
    session: () => ({ user: ada, error: false }),
    persist,
    refresh: () => refresh.promise,
  });
  const first = editor.save("ada", { field: "image", value: "new" });
  await Promise.resolve();
  expect(await editor.save("ada", { field: "image", value: "other" })).toEqual({ status: "busy" });
  expect(persist).toHaveBeenCalledOnce();
  expect(editor.getSnapshot().edits.image).toEqual({ value: "new", status: "confirmed" });
  expect(editor.isPending("ada", "image")).toBe(true);
  refresh.resolve();
  await first;
  expect(editor.isPending("ada", "image")).toBe(false);
});

test("a name refresh cannot erase a newer pending avatar edit", async () => {
  let user = ada;
  const image = deferred();
  const editor = new ProfileEditor({
    session: () => ({ user, error: false }),
    persist: async (_owner, change) => {
      if (change.field === "image") {
        await image.promise;
        user = { ...user, image: change.value };
      } else user = { ...user, name: change.value };
    },
    refresh: async () => {},
  });
  const saving = editor.save("ada", { field: "image", value: "new" });
  await editor.save("ada", { field: "name", value: "Updated" });
  expect(user.name).toBe("Updated");
  expect(editor.getSnapshot().edits).toEqual({ image: { value: "new", status: "pending" } });
  image.resolve();
  await saving;
  expect(editor.getSnapshot().edits).toEqual({});
});

test("an old owner's late failure cannot roll back the next account", async () => {
  let user = ada;
  let reject!: (error: Error) => void;
  const request = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const refresh = vi.fn();
  const editor = new ProfileEditor({
    session: () => ({ user, error: false }),
    persist: () => request,
    refresh,
  });
  const saving = editor.save("ada", { field: "name", value: "Private draft" });
  user = grace;
  editor.receive({ user, error: false });
  reject(new Error("Old failure"));
  expect(await saving).toEqual({ status: "inactive" });
  expect(editor.getSnapshot().ownerId).toBe(grace.id);
  expect(refresh).not.toHaveBeenCalled();
  expect(editor.getSnapshot().edits).toEqual({});
});

test.each(["reported", "thrown"])(
  "a %s refresh error does not turn a confirmed mutation into a failed save",
  async (failure) => {
    let error = false;
    let user = ada;
    const editor = new ProfileEditor({
      session: () => ({ user, error }),
      persist: async () => {},
      refresh: async () => {
        if (failure === "thrown") throw new Error("Refresh failed");
        error = true;
      },
    });
    expect(await editor.save("ada", { field: "name", value: "Saved" })).toEqual({
      status: "saved",
      refreshed: false,
    });
    expect(editor.getSnapshot().edits.name).toEqual({ value: "Saved", status: "confirmed" });
    error = false;
    user = { ...ada, name: "Saved" };
    editor.receive({ user, error });
    expect(editor.getSnapshot().edits).toEqual({});
  },
);

test("a failed name edit rolls back only that field while an avatar is pending", async () => {
  const image = deferred();
  const editor = new ProfileEditor({
    session: () => ({ user: ada, error: false }),
    persist: async (_owner, change) => {
      if (change.field === "name") throw new Error("Name failed");
      await image.promise;
    },
    refresh: async () => {},
  });
  const saving = editor.save("ada", { field: "image", value: "new" });
  expect(await editor.save("ada", { field: "name", value: "Updated" })).toEqual({
    status: "failed",
    error: "Name failed",
  });
  expect(editor.getSnapshot().edits).toEqual({ image: { value: "new", status: "pending" } });
  expect(editor.isPending("ada", "image")).toBe(true);
  image.resolve();
  await saving;
});

test("a confirmed edit follows a fresh server value if another writer superseded it", async () => {
  let user = ada;
  const editor = new ProfileEditor({
    session: () => ({ user, error: false }),
    persist: async () => {},
    refresh: async () => {
      user = { ...ada, name: "Newer server name" };
    },
  });
  expect(await editor.save("ada", { field: "name", value: "This window's name" })).toEqual({
    status: "saved",
    refreshed: true,
  });
  expect(editor.getSnapshot().edits).toEqual({});
  expect(user.name).toBe("Newer server name");
});
