"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useAuth } from "../../components/auth-provider";
import { apiUrl } from "../../lib/api";

export default function AuthCompletePage() {
  const { apiFetch, isLoading, user } = useAuth();
  const router = useRouter();
  const hasStarted = useRef(false);

  useEffect(() => {
    if (isLoading || hasStarted.current) return;

    if (!user) {
      router.replace("/login");
      return;
    }

    hasStarted.current = true;
    void Promise.all([
      apiFetch(`${apiUrl}/auth/me`),
      // Give the route handoff enough time to read as one intentional motion
      // instead of flashing an intermediate screen on fast connections.
      new Promise((resolve) => window.setTimeout(resolve, 520)),
    ]).finally(() => {
      router.replace("/home");
    });
  }, [apiFetch, isLoading, router, user]);

  return (
    <main className="paper-grid flex min-h-screen items-center justify-center bg-[#f4f6f2] px-6 text-emerald-950">
      <section
        className="auth-transition-in flex w-full max-w-sm flex-col items-center text-center"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="auth-transition-mark flex size-20 items-center justify-center rounded-[1.65rem] bg-emerald-950 shadow-[0_18px_50px_-20px_rgba(16,34,31,.65)]">
          <span
            aria-hidden="true"
            className="-mt-1 text-4xl font-black tracking-[-.12em] text-white"
          >
            t<span className="text-[#9cf0d1]">.</span>
          </span>
        </div>
        <p className="mt-7 text-[10px] font-black tracking-[.22em] text-emerald-700">
          YOU&apos;RE ALL SET
        </p>
        <h1 className="mt-3 text-3xl font-black tracking-[-.055em]">Opening Tracera</h1>
        <p className="mt-3 text-sm leading-6 text-emerald-950/55">
          Securing your session and preparing your workspace.
        </p>
        <div className="mt-7 h-1 w-36 overflow-hidden rounded-full bg-emerald-950/10">
          <div className="auth-transition-progress h-full w-full rounded-full bg-emerald-700" />
        </div>
      </section>
    </main>
  );
}
