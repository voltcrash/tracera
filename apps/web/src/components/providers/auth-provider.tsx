import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useLocation, useNavigate, useRouterState } from "@tanstack/react-router";
import { authClient, currentClientSession } from "@/lib/auth-client";
import { authPhase, PROFILE_OWNER_HEADER, type AuthPhase, type AuthUser } from "@/lib/auth-state";
import {
  ProfileEditor,
  type ProfileChange,
  type ProfileField,
  type ProfileSaveResult,
} from "@/lib/profile-editor";
import { clearSessionCache } from "@/lib/session-cache";
import { Button } from "@/components/ui/button";

export type { AuthUser } from "@/lib/auth-state";

export function accountLabel(user: AuthUser) {
  return user.name.trim() || user.email;
}

type AuthContextValue = {
  user: AuthUser | null;
  status: AuthPhase;
  isLoading: boolean;
  saveProfile: (change: ProfileChange) => Promise<ProfileSaveResult>;
  isProfilePending: (field: ProfileField) => boolean;
  signOut: () => Promise<void>;
};
const AuthContext = createContext<AuthContextValue | null>(null);
const PUBLIC_PATHS = new Set(["/", "/auth/error"]);

function normalizedUser(
  user: NonNullable<ReturnType<typeof authClient.useSession>["data"]>["user"] | undefined,
): AuthUser | null {
  return user
    ? {
        id: user.id,
        email: user.email,
        name: user.name ?? "",
        image: user.image ?? null,
        createdAt: new Date(user.createdAt).toISOString(),
      }
    : null;
}
function clientSession() {
  const session = currentClientSession();
  return {
    user: normalizedUser(session.data?.user),
    error: Boolean(session.error),
    refreshing: session.isRefetching,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const session = authClient.useSession();
  const { refetch } = session;
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const sessionUser = useMemo(() => normalizedUser(session.data?.user), [session.data?.user]);
  const [failedCheck, setFailedCheck] = useState(false);
  if (session.error && session.error.status !== 401 && !failedCheck) setFailedCheck(true);
  else if (
    session.error?.status === 401 ||
    (!session.error && !session.isPending && !session.isRefetching)
  ) {
    if (failedCheck) setFailedCheck(false);
  }
  const [signedOutSession, setSignedOutSession] = useState<string | null>(null);
  const knownSignedOut = Boolean(signedOutSession && session.data?.session.id === signedOutSession);
  const phase = knownSignedOut
    ? "anonymous"
    : authPhase({ ...session, user: sessionUser }, failedCheck);
  const [editor] = useState(
    () =>
      new ProfileEditor({
        session: clientSession,
        persist: async (ownerId, change) => {
          const result = await authClient.updateUser({
            ...(change.field === "name" ? { name: change.value } : { image: change.value }),
            fetchOptions: { headers: { [PROFILE_OWNER_HEADER]: ownerId } },
          });
          if (result.error)
            throw new Error(
              result.error.message ?? "Unable to confirm your profile change. Try again.",
            );
        },
        refresh: () => currentClientSession().refetch(),
      }),
  );
  const profile = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  useEffect(() => {
    const snapshot = clientSession();
    editor.receive(knownSignedOut ? { ...snapshot, user: null } : snapshot);
  }, [editor, knownSignedOut, sessionUser, session.error, session.isRefetching, session.isPending]);
  const user = useMemo(
    () =>
      phase === "authenticated" && sessionUser
        ? profile.ownerId === sessionUser.id
          ? {
              ...sessionUser,
              ...(profile.edits.name ? { name: profile.edits.name.value } : {}),
              ...(profile.edits.image ? { image: profile.edits.image.value } : {}),
            }
          : sessionUser
        : null,
    [phase, profile, sessionUser],
  );
  const routeOwner = useRouterState({
    select: ({ matches }) => {
      const context = matches.find((match) => match.routeId === "/_workspace")?.context as
        | { user?: { id: string } }
        | undefined;
      return context?.user?.id ?? null;
    },
  });
  const [documentOwner, setDocumentOwner] = useState(routeOwner);
  const observedOwner = routeOwner ?? user?.id ?? null;
  if (documentOwner === null && observedOwner !== null) setDocumentOwner(observedOwner);
  const changedOwner = Boolean(
    user &&
    ((documentOwner && user.id !== documentOwner) || (routeOwner && user.id !== routeOwner)),
  );
  useEffect(() => {
    if (changedOwner) {
      clearSessionCache();
      window.location.reload();
    }
  }, [changedOwner]);
  const [retryError, setRetryError] = useState(false);
  const isPublic = PUBLIC_PATHS.has(pathname);
  useEffect(() => {
    if (phase === "anonymous" && !isPublic) void navigate({ to: "/", replace: true });
  }, [isPublic, navigate, phase]);

  const signOuts = useRef(new Map<string, Promise<void>>());
  const requestSignOut = useCallback(
    (expectedOwner: string) => {
      const current = currentClientSession();
      const owner = current.data?.user.id;
      const id = current.data?.session.id;
      if (!owner || !id) return Promise.resolve();
      if (owner !== expectedOwner)
        return Promise.reject(new Error("The signed-in account changed. Please try again."));
      const pending = signOuts.current.get(id);
      if (pending) return pending;
      const request = (async () => {
        const result = await authClient.signOut({
          fetchOptions: { headers: { [PROFILE_OWNER_HEADER]: owner } },
        });
        if (result.error)
          throw new Error(result.error.message ?? "Unable to sign out. Please try again.");
        setSignedOutSession(id);
        if (clientSession().user?.id === owner) editor.receive({ user: null, error: false });
        clearSessionCache();
        await refetch();
      })().finally(() => signOuts.current.delete(id));
      signOuts.current.set(id, request);
      return request;
    },
    [editor, refetch],
  );
  const status = phase;
  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      isLoading: status === "pending",
      saveProfile: (change) =>
        user ? editor.save(user.id, change) : Promise.resolve({ status: "inactive" }),
      isProfilePending: (field) => Boolean(user && profile.pending.includes(`${user.id}:${field}`)),
      signOut: () => (user ? requestSignOut(user.id) : Promise.resolve()),
    }),
    [editor, profile, requestSignOut, status, user],
  );

  function retry() {
    setRetryError(false);
    void refetch().catch(() => setRetryError(true));
  }
  const unavailable = !knownSignedOut && (phase === "error" || retryError || failedCheck);
  // The guarded outlet must mount while pending so SSR and session hydration can finish.
  return (
    <AuthContext.Provider value={value}>
      {changedOwner ? (
        <p role="status">Refreshing your workspace…</p>
      ) : isPublic ? (
        children
      ) : unavailable ? (
        <main className="mx-auto max-w-lg p-8">
          <h1>Unable to check your session</h1>
          <p>Your session could not be confirmed. Please try again.</p>
          <Button type="button" onClick={retry} disabled={session.isRefetching}>
            {session.isRefetching ? "Checking session…" : "Retry session"}
          </Button>
        </main>
      ) : status === "pending" || user ? (
        children
      ) : null}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider.");
  return context;
}
