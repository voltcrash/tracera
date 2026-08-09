"use client";

import { useEffect, useState } from "react";

export function AuthLoadingState() {
  const [isTakingLonger, setIsTakingLonger] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setIsTakingLonger(true), 6000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      className="flex min-h-56 w-full flex-col items-center justify-center rounded-3xl border border-emerald-950/10 bg-white/70 px-8 text-center shadow-sm"
      role="status"
      aria-live="polite"
    >
      <span className="size-7 animate-spin rounded-full border-2 border-emerald-950/15 border-t-emerald-800" />
      <p className="mt-5 text-sm font-bold text-emerald-950">
        {isTakingLonger ? "Authentication is taking longer than expected" : "Loading secure sign-in…"}
      </p>
      {isTakingLonger && (
        <p className="mt-2 max-w-xs text-xs leading-5 text-emerald-950/55">
          Reload this page. If it still does not open, check that your browser
          is not blocking requests from this site.
        </p>
      )}
    </div>
  );
}
