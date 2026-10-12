import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
import { clearSessionCache } from "@/lib/session-cache";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  image: string | null;
  createdAt: string;
};

/** The display name replaces the email everywhere the account is shown. */
export function accountLabel(user: AuthUser) {
  return user.name.trim() || user.email;
}

type AuthContextValue = {
  user: AuthUser | null;
  isLoading: boolean;
  refreshUser: () => Promise<void>;
  updateUser: (changes: Partial<Pick<AuthUser, "image" | "name">>) => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
/** Pages anonymous visitors may stay on; the workspace guard handles the rest on the server. */
const PUBLIC_PATHS = new Set(["/", "/auth/error"]);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const session = authClient.useSession();
  const { refetch } = session;
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const sessionDataUser = session.data?.user;
  const sessionUser = useMemo<AuthUser | null>(() => {
    if (!sessionDataUser) return null;
    return {
      id: sessionDataUser.id,
      email: sessionDataUser.email,
      name: sessionDataUser.name ?? "",
      image: sessionDataUser.image ?? null,
      createdAt: new Date(sessionDataUser.createdAt).toISOString(),
    };
  }, [sessionDataUser]);
  const [optimisticUser, setOptimisticUser] = useState<AuthUser | null>(null);
  const user = sessionUser ? (optimisticUser ?? sessionUser) : null;

  const updateUser = useCallback(
    (changes: Partial<Pick<AuthUser, "image" | "name">>) => {
      setOptimisticUser((current) => {
        const source = current ?? sessionUser;
        return source ? { ...source, ...changes } : null;
      });
    },
    [sessionUser],
  );
  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading: session.isPending,
      refreshUser: async () => {
        await refetch();
        setOptimisticUser(null);
      },
      updateUser,
      signOut: async () => {
        await authClient.signOut();
        setOptimisticUser(null);
        clearSessionCache();
      },
    }),
    [refetch, session.isPending, updateUser, user],
  );

  const isPublic = PUBLIC_PATHS.has(pathname);
  useEffect(() => {
    if (!session.isPending && !user && !isPublic) void navigate({ to: "/", replace: true });
  }, [isPublic, navigate, session.isPending, user]);

  const canRender = isPublic || session.isPending || Boolean(user);

  return <AuthContext.Provider value={value}>{canRender ? children : null}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider.");
  return context;
}
