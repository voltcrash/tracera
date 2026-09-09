"use client";

import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

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
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const session = authClient.useSession();
  const { refetch } = session;
  const pathname = usePathname();
  const router = useRouter();
  const apiFetch = useCallback(
    (input: string, init: RequestInit = {}) => fetch(input, { ...init, credentials: "include" }),
    [],
  );
  const user = useMemo<AuthUser | null>(() => {
    if (!session.data?.user) return null;
    return {
      id: session.data.user.id,
      email: session.data.user.email,
      name: session.data.user.name ?? "",
      image: session.data.user.image ?? null,
      createdAt: new Date(session.data.user.createdAt).toISOString(),
    };
  }, [session.data?.user]);
  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading: session.isPending,
      apiFetch,
      refreshUser: async () => {
        await refetch();
      },
      signOut: async () => {
        await authClient.signOut();
      },
    }),
    [apiFetch, refetch, session.isPending, user],
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
