"use client";

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
        <div className="rounded-3xl border border-emerald-950/10 bg-white p-8 shadow-sm">
          <p className="text-xs font-black tracking-[.18em] text-emerald-700">
            ACCOUNT ACCESS PAUSED
          </p>
          <h1 className="mt-4 text-3xl font-extrabold tracking-tight">
            Account creation is being upgraded.
          </h1>
          <p className="mt-3 leading-7 text-emerald-950/65">
            Please check back shortly.
          </p>
        </div>
      </section>
    </main>
  );
}
