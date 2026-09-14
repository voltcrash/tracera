"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SocialSignInButton } from "./social-sign-in-button";

type LocalIdentity = { id: string; name: string };

export function SignInOptions() {
  const [identities, setIdentities] = useState<LocalIdentity[] | null>(null);
  const [localChecked, setLocalChecked] = useState(false);

  useEffect(() => {
    void fetch("/api/auth/dev-identities", { credentials: "same-origin" })
      .then(async (response) => (response.ok ? ((await response.json()).identities ?? []) : []))
      .then((value) => setIdentities(value))
      .catch(() => setIdentities([]))
      .finally(() => setLocalChecked(true));
  }, []);

  if (!localChecked) {
    return <p className="text-sm text-ink-faint">Checking sign-in options…</p>;
  }

  if (identities && identities.length > 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-soft">Local development identities</p>
        <div className="flex flex-col gap-3 sm:flex-row">
          {identities.map((identity) => (
            <Button
              key={identity.id}
              render={
                <a
                  href={`/api/auth/dev-login?identity=${identity.id}`}
                  aria-label={`Continue as ${identity.name}`}
                />
              }
              variant="brand"
              size="lg"
              nativeButton={false}
              className="color-sweep-button story-auth-cta"
            >
              Continue as {identity.name}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <SocialSignInButton
        provider="google"
        variant="brand"
        size="lg"
        className="color-sweep-button story-auth-cta"
      />
      <SocialSignInButton
        provider="github"
        variant="brand"
        size="lg"
        className="color-sweep-button story-auth-cta"
      />
    </div>
  );
}
