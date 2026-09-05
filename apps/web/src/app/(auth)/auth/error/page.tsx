"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const ERROR_MESSAGES = new Map<string, string>(
  Object.entries({
    access_denied: "Google sign-in was cancelled.",
    no_code: "Google sign-in was cancelled or could not be completed.",
    state_mismatch: "Your sign-in request expired or could not be verified. Please try again.",
    state_not_found: "Your sign-in request expired or could not be verified. Please try again.",
    state_invalid: "Your sign-in request expired or could not be verified. Please try again.",
    email_not_found: "Google did not provide an email address for this account.",
    account_already_linked_to_different_user:
      "This Google account is already connected to another Tracera account.",
    oauth_provider_not_found:
      "Google sign-in is temporarily unavailable. Please try again shortly.",
    invalid_code: "The sign-in response could not be verified. Please try again.",
    invalid_callback_request: "The sign-in response could not be verified. Please try again.",
  }),
);

export default function AuthErrorPage() {
  return (
    <Suspense fallback={null}>
      <AuthError />
    </Suspense>
  );
}

function AuthError() {
  const params = useSearchParams();
  const errorCode = params.get("error") ?? "unknown";
  const retryURL = params.get("flow") === "signup" ? "/signup" : "/login";
  const message =
    ERROR_MESSAGES.get(errorCode) ?? "We could not complete sign-in. Please try again shortly.";

  return (
    <main className="paper-grid flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md rounded-3xl p-2">
        <CardHeader>
          <Link href="/" className="text-lg font-extrabold tracking-tight">
            tracera<span className="text-brand-emerald">.</span>
          </Link>
          <CardTitle className="mt-8 text-3xl font-extrabold tracking-[-.04em]">
            Sign-in didn&apos;t complete
          </CardTitle>
          <CardDescription className="mt-2 leading-relaxed">{message}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row">
          <Button render={<Link href={retryURL} />} size="lg" className="flex-1">
            Try again
          </Button>
          <Button render={<Link href="/" />} size="lg" variant="outline" className="flex-1">
            Return home
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
