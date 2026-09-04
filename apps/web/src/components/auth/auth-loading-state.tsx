"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";

export function AuthLoadingState() {
  const [isTakingLonger, setIsTakingLonger] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setIsTakingLonger(true), 6000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <Card
      className="min-h-56 w-full items-center justify-center rounded-3xl bg-card/70 px-8 text-center"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-7 animate-spin text-brand-emerald" />
      <p className="text-sm font-black">
        {isTakingLonger
          ? "Authentication is taking longer than expected"
          : "Loading secure sign-in…"}
      </p>
      {isTakingLonger && (
        <p className="-mt-3 max-w-xs text-xs leading-5 text-muted-foreground">
          Reload this page. If it still does not open, check that your browser is not blocking
          requests from this site.
        </p>
      )}
    </Card>
  );
}
