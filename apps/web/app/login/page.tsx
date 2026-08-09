"use client";

import { ClerkLoaded, ClerkLoading, SignIn } from "@clerk/nextjs";
import Link from "next/link";
import { AuthLoadingState } from "../components/auth-loading-state";

export default function LoginPage() {
  return (
    <main className="grid min-h-screen bg-[#f7faf9] lg:grid-cols-2">
      <section className="hidden bg-emerald-950 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <Link href="/" className="text-lg font-extrabold tracking-tight">
          tracera<span className="text-[#9cf0d1]">.</span>
        </Link>
        <div>
          <p className="text-xs font-black tracking-[.18em] text-[#9cf0d1]">
            EVIDENCE, NOT ECHOES
          </p>
          <h1 className="mt-5 max-w-md text-5xl font-extrabold leading-[1.05] tracking-[-.04em]">
            Less noise. Better judgment.
          </h1>
          <p className="mt-6 max-w-md text-lg leading-8 text-white/70">
            Save analyses, follow how a story changes, and build a clearer
            picture of the information you encounter.
          </p>
        </div>
        <p className="text-sm text-white/50">
          Authentication and account security are protected by Clerk.
        </p>
      </section>
      <section className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md">
          <Link
            href="/"
            className="mb-10 inline-block text-sm font-semibold text-slate-500 hover:text-slate-950"
          >
            ← Back to Tracera
          </Link>
          <ClerkLoading>
            <AuthLoadingState />
          </ClerkLoading>
          <ClerkLoaded>
            <SignIn
              routing="hash"
              signUpUrl="/signup"
              forceRedirectUrl="/auth/complete"
            />
          </ClerkLoaded>
        </div>
      </section>
    </main>
  );
}
