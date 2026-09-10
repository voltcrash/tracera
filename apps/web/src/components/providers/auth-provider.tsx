"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
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
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>;
  refreshUser: () => Promise<void>;
  updateUser: (changes: Partial<Pick<AuthUser, "image" | "name">>) => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const session = authClient.useSession();
  const { refetch } = session;
  const pathname = usePathname();
  const router = useRouter();
  const sessionDataUser = session.data?.user;
  const apiFetch = useCallback(
    (input: string, init: RequestInit = {}) => fetch(input, { ...init, credentials: "include" }),
    [],
  );
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
      apiFetch,
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
    [apiFetch, refetch, session.isPending, updateUser, user],
  );

  useEffect(() => {
    if (!session.isPending && !user && pathname !== "/") router.replace("/");
  }, [pathname, router, session.isPending, user]);

  const canRender = pathname === "/" || session.isPending || Boolean(user);

  return <AuthContext.Provider value={value}>{canRender ? children : null}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider.");
  return context;
}
