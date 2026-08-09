"use client";

import {
  ClerkProvider,
  useAuth as useClerkAuth,
  useClerk,
  useUser,
} from "@clerk/nextjs";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from "react";
import { apiUrl } from "../lib/api";

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
  return (
    <ClerkProvider
      publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
      signInUrl="/login"
      signUpUrl="/signup"
      signInForceRedirectUrl="/auth/complete"
      signUpForceRedirectUrl="/auth/complete"
      signInFallbackRedirectUrl="/auth/complete"
      signUpFallbackRedirectUrl="/auth/complete"
    >
      <AuthBridge>{children}</AuthBridge>
    </ClerkProvider>
  );
}

function AuthBridge({ children }: { children: React.ReactNode }) {
  const { getToken, isLoaded, isSignedIn } = useClerkAuth();
  const { signOut: clerkSignOut } = useClerk();
  const { isLoaded: isUserLoaded, user: clerkUser } = useUser();

  const apiFetch = useCallback(
    async (input: string, init: RequestInit = {}) => {
      const token = await getToken();
      const headers = new Headers(init.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    },
    [getToken],
  );

  // Provision/link the local Tracera profile as soon as Clerk restores a session.
  useEffect(() => {
    if (isSignedIn) void apiFetch(`${apiUrl}/auth/me`);
  }, [apiFetch, isSignedIn]);

  const user = useMemo<AuthUser | null>(() => {
    const email = clerkUser?.primaryEmailAddress?.emailAddress;
    if (!clerkUser || !email) return null;
    return {
      id: clerkUser.id,
      email,
      createdAt:
        clerkUser.createdAt?.toISOString() ?? new Date(0).toISOString(),
    };
  }, [clerkUser]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      // Clerk's session and user resources finish independently. Waiting for
      // both prevents the destination header from briefly flashing "Log in"
      // after a successful sign-in.
      isLoading: !isLoaded || !isUserLoaded,
      apiFetch,
      signOut: () => clerkSignOut({ redirectUrl: "/" }),
    }),
    [apiFetch, clerkSignOut, isLoaded, isUserLoaded, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider.");
  return context;
}
