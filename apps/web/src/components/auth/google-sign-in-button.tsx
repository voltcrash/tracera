"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type GoogleSignInButtonProps = {
  className?: string;
  expandable?: boolean;
  size?: "sm" | "default" | "lg";
  variant?: "default" | "outline";
};

export function GoogleSignInButton({
  className,
  expandable = false,
  size = "default",
  variant = "outline",
}: GoogleSignInButtonProps) {
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signInWithGoogle() {
    setIsStarting(true);
    setError(null);

    const result = await authClient.signIn.social({
      provider: "google",
      callbackURL: "/auth/complete",
      errorCallbackURL: "/auth/error?flow=login&provider=google",
    });

    if (result.error) {
      setError(result.error.message ?? "Google sign-in could not start.");
      setIsStarting(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={cn(expandable && "google-sign-in-button", className)}
        disabled={isStarting}
        aria-label={isStarting ? "Opening Google sign-in" : "Sign in with Google"}
        onClick={() => void signInWithGoogle()}
      >
        {isStarting ? (
          <>
            <Loader2 className="animate-spin" />
            <span>Opening Google…</span>
          </>
        ) : (
          <span className="flex items-center">
            <span>Sign in</span>
            <span className={cn("flex items-center gap-2", expandable && "google-sign-in-more")}>
              <span>&nbsp;with</span>
              <GoogleMark />
            </span>
          </span>
        )}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {error}
      </span>
    </>
  );
}

export function GoogleMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-5"
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
  );
}
