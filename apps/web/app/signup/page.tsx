"use client";

import { SignUp } from "@clerk/nextjs";
import Link from "next/link";

export default function SignupPage() {
  return (
    <main className="paper-grid flex min-h-screen items-center justify-center bg-[#f4f6f2] p-6 text-emerald-950">
      <section className="w-full max-w-md">
        <Link
          href="/"
          className="mb-8 inline-block text-sm font-bold text-emerald-800"
        >
          ← Back to Tracera
        </Link>
        <SignUp
          routing="hash"
          signInUrl="/login"
          forceRedirectUrl="/auth/complete"
          appearance={{
            variables: {
              colorBackground: "var(--tracera-surface)",
              colorForeground: "var(--tracera-foreground)",
              colorInput: "var(--tracera-surface-subtle)",
              colorInputForeground: "var(--tracera-foreground)",
              colorMutedForeground: "var(--tracera-muted)",
            },
          }}
        />
      </section>
    </main>
  );
}
