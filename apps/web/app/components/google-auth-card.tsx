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
      errorCallbackURL: `/auth/error?flow=${mode}&provider=google`,
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
        <svg
          aria-hidden="true"
          className="size-5 shrink-0"
          viewBox="0 0 18 18"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.909c1.702-1.567 2.683-3.874 2.683-6.614Z"
            fill="#4285F4"
          />
          <path
            d="M9 18c2.43 0 4.468-.806 5.957-2.18l-2.909-2.259c-.806.54-1.836.859-3.048.859-2.344 0-4.328-1.585-5.037-3.714H.956v2.332A9 9 0 0 0 9 18Z"
            fill="#34A853"
          />
          <path
            d="M3.963 10.706A5.41 5.41 0 0 1 3.682 9c0-.592.102-1.167.281-1.706V4.962H.956A9 9 0 0 0 0 9c0 1.452.347 2.827.956 4.038l3.007-2.332Z"
            fill="#FBBC05"
          />
          <path
            d="M9 3.58c1.321 0 2.507.454 3.441 1.346l2.581-2.581C13.464.892 11.43 0 9 0A9 9 0 0 0 .956 4.962l3.007 2.332C4.672 5.165 6.656 3.58 9 3.58Z"
            fill="#EA4335"
          />
        </svg>
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
