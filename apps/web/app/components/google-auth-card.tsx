"use client";

import { useState } from "react";
import { authClient } from "../lib/auth-client";

export function GoogleAuthCard({ mode }: { mode: "login" | "signup" }) {
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function continueWithGoogle() {
    setIsStarting(true);
    setError(null);
    const result = await authClient.signIn.social({
      provider: "google",
      callbackURL: "/auth/complete",
      errorCallbackURL: `/${mode}?error=oauth`,
    });
    if (result.error) {
      setError(result.error.message ?? "Google sign-in could not start.");
      setIsStarting(false);
    }
  }

  return (
    <div className="rounded-3xl border border-emerald-950/10 bg-white p-8 shadow-sm">
      <p className="text-xs font-black tracking-[.18em] text-emerald-700">
        YOUR TRACERA ACCOUNT
      </p>
      <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-emerald-950">
        {mode === "signup" ? "Create your account" : "Welcome back"}
      </h2>
      <p className="mt-3 leading-7 text-slate-600">
        Continue with your Google email to keep evidence trails synced across
        Tracera.
      </p>
      <button
        className="mt-7 flex w-full items-center justify-center gap-3 rounded-xl border border-slate-300 bg-white px-5 py-3.5 text-sm font-bold text-slate-800 transition hover:-translate-y-0.5 hover:border-emerald-800 disabled:cursor-wait disabled:opacity-60"
        disabled={isStarting}
        onClick={() => void continueWithGoogle()}
        type="button"
      >
        <span
          aria-hidden="true"
          className="flex size-6 items-center justify-center rounded-full bg-slate-100 text-sm font-black text-blue-600"
        >
          G
        </span>
        {isStarting ? "Opening Google…" : "Continue with Google"}
      </button>
      {error ? (
        <p className="mt-4 text-sm font-semibold text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      <p className="mt-6 text-xs leading-5 text-slate-500">
        Tracera hosts its account UI and session endpoints on this site. Google
        is contacted only after you continue.
      </p>
    </div>
  );
}
