"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { GoogleMark } from "@/components/auth/google-sign-in-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
    <Card className="rounded-3xl p-2">
      <CardHeader>
        <CardTitle className="text-3xl font-extrabold tracking-[-.04em]">
          {mode === "signup" ? "Create your account" : "Welcome back"}
        </CardTitle>
        <CardDescription className="mt-2 leading-relaxed">
          Continue with your Google email to keep evidence trails synced across Tracera.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          variant="outline"
          size="lg"
          className="w-full"
          disabled={isStarting}
          onClick={() => void continueWithGoogle()}
          type="button"
        >
          {isStarting ? <Loader2 className="animate-spin" /> : <GoogleMark />}
          {isStarting ? "Opening Google…" : "Continue with Google"}
        </Button>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <p className="text-xs leading-5 text-muted-foreground">
          Tracera hosts its account UI and session endpoints on this site. Google is contacted only
          after you continue.
        </p>
      </CardContent>
    </Card>
  );
}
