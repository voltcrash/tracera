"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { SocialSignInButton, type SocialProvider } from "@/components/auth/social-sign-in-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const PROVIDER_NAMES: Record<SocialProvider, string> = { github: "GitHub", google: "Google" };

function errorMessage(errorCode: string, provider: SocialProvider | null) {
  const providerName = provider ? PROVIDER_NAMES[provider] : "The provider";
  const messages: Record<string, string> = {
    access_denied: `${providerName} sign-in was cancelled.`,
    no_code: `${providerName} sign-in was cancelled or could not be completed.`,
    state_mismatch: "Your sign-in request expired or could not be verified. Please try again.",
    state_not_found: "Your sign-in request expired or could not be verified. Please try again.",
    state_invalid: "Your sign-in request expired or could not be verified. Please try again.",
    email_not_found: `${providerName} did not provide an email address for this account.`,
    email_not_verified: `${providerName} did not provide a verified email address for this account.`,
    account_already_linked_to_different_user: `This ${providerName} account is already connected to another Tracera account.`,
    oauth_provider_not_found: `${providerName} sign-in is temporarily unavailable. Please try again shortly.`,
    unable_to_get_user_info: `${providerName} could not provide the account details needed to sign in.`,
    account_not_linked: `This email already has a Tracera account, but ${providerName} could not link to it securely. Sign in with your existing method first.`,
    unable_to_link_account: `Tracera could not securely link this ${providerName} account.`,
    email_does_not_match: `${providerName} returned a different email address for this account.`,
    invalid_code: "The sign-in response could not be verified. Please try again.",
    invalid_callback_request: "The sign-in response could not be verified. Please try again.",
  };
  return messages[errorCode] ?? "We could not complete sign-in. Please try again shortly.";
}

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
  const providerParam = params.get("provider");
  const provider = providerParam === "github" || providerParam === "google" ? providerParam : null;
  const message = errorMessage(errorCode, provider);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md rounded-3xl p-2">
        <CardHeader>
          <Link href="/" className="text-lg font-extrabold tracking-tight">
            tracera<span className="text-brand-lime-ink">.</span>
          </Link>
          <CardTitle className="mt-8 text-3xl font-extrabold tracking-[-.04em]">
            Sign-in didn&apos;t complete
          </CardTitle>
          <CardDescription className="mt-2 leading-relaxed">{message}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row">
          {provider ? (
            <SocialSignInButton
              provider={provider}
              label={`Try ${PROVIDER_NAMES[provider]} again`}
              size="lg"
              variant="default"
              className="flex-1"
            />
          ) : null}
          <Button render={<Link href="/" />} size="lg" variant="outline" className="flex-1">
            Return home
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
