"use client";

import Link from "next/link";

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
          Account access is temporarily unavailable while authentication is
          upgraded.
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
          <div className="rounded-3xl border border-emerald-950/10 bg-white p-8 shadow-sm">
            <p className="text-xs font-black tracking-[.18em] text-emerald-700">
              ACCOUNT ACCESS PAUSED
            </p>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-emerald-950">
              Sign-in is being upgraded.
            </h2>
            <p className="mt-3 leading-7 text-slate-600">
              Please check back shortly.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
