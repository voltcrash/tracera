"use client";

import { createContext, useCallback, useContext, useMemo } from "react";

export type AuthUser = {
  id: string;
  email: string;
  createdAt: string;
};

type AuthContextValue = {
  user: AuthUser | null;
  isLoading: boolean;
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const apiFetch = useCallback(
    (input: string, init: RequestInit = {}) => fetch(input, init),
    [],
  );
  const value = useMemo<AuthContextValue>(
    () => ({
      user: null,
      isLoading: false,
      apiFetch,
      signOut: async () => undefined,
    }),
    [apiFetch],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider.");
  return context;
}
