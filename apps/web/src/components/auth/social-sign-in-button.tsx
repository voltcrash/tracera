import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { GitHubMark } from "@/components/brand/github-mark";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { startSocialSignIn, type SignInState } from "@/lib/auth-state";

export type SocialProvider = "github" | "google";

type SocialSignInButtonProps = {
  provider: SocialProvider;
  className?: string;
  label?: string;
  size?: "sm" | "default" | "lg";
  variant?: "default" | "brand" | "lime" | "outline";
};

const PROVIDER_NAMES: Record<SocialProvider, string> = {
  github: "GitHub",
  google: "Google",
};

export function SocialSignInButton({
  provider,
  className,
  label,
  size = "default",
  variant = "outline",
}: SocialSignInButtonProps) {
  const [state, setState] = useState<SignInState>({ status: "idle" });
  const pending = useRef(false);
  const isStarting = state.status === "starting" || state.status === "redirecting";
  const error = state.status === "failed" ? state.error : null;
  const providerName = PROVIDER_NAMES[provider];

  async function signIn() {
    if (pending.current) return;
    pending.current = true;
    setState({ status: "starting" });
    const next = await startSocialSignIn(
      () =>
        authClient.signIn.social({
          provider,
          callbackURL: "/home",
          errorCallbackURL: `/auth/error?flow=login&provider=${provider}`,
        }),
      providerName,
    );
    pending.current = next.status === "redirecting";
    setState(next);
  }

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        disabled={isStarting}
        aria-label={
          isStarting
            ? `Opening ${providerName} sign-in`
            : (label ?? `Continue with ${providerName}`)
        }
        onClick={() => void signIn()}
      >
        {isStarting ? (
          <>
            <Loader2 className="animate-spin" />
            <span>Opening {providerName}…</span>
          </>
        ) : (
          <>
            <ProviderMark provider={provider} />
            <span>{label ?? `Continue with ${providerName}`}</span>
          </>
        )}
      </Button>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function ProviderMark({ provider }: { provider: SocialProvider }) {
  return provider === "github" ? <GitHubMark className="size-5" /> : <GoogleMark />;
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
