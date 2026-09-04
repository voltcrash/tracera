"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { GoogleAuthCard } from "../components/google-auth-card";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  return (
    <main className="grid min-h-screen bg-background lg:grid-cols-2">
      <section className="hidden bg-brand-ink p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <Link href="/" className="text-lg font-extrabold tracking-tight">
          tracera<span className="text-brand-mint">.</span>
        </Link>
        <div>
          <h1 className="max-w-md text-5xl font-black leading-[1.02] tracking-[-.045em]">
            Less noise. Better judgment.
          </h1>
          <p className="mt-6 max-w-md text-lg leading-relaxed text-white/70">
            Save analyses, follow how a story changes, and build a clearer picture of the
            information you encounter.
          </p>
        </div>
        <p className="text-sm text-white/50">
          Your session stays on Tracera. Continue to Google only when you are ready to sign in.
        </p>
      </section>
      <section className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md">
          <Button asChild variant="ghost" size="sm" className="mb-10 -ml-3 text-muted-foreground">
            <Link href="/">
              <ArrowLeft />
              Back to Tracera
            </Link>
          </Button>
          <GoogleAuthCard mode="login" />
        </div>
      </section>
    </main>
  );
}
