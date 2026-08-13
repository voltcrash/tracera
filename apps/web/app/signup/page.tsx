"use client";

import Link from "next/link";
import { GoogleAuthCard } from "../components/google-auth-card";

export default function SignupPage() {
  return (
    <main className="paper-grid flex min-h-screen items-center justify-center bg-[#f4f6f2] p-6 text-emerald-950">
      <section className="w-full max-w-md">
        <Link href="/" className="mb-8 inline-block text-sm font-bold text-emerald-800">
          ← Back to Tracera
        </Link>
        <GoogleAuthCard mode="signup" />
      </section>
    </main>
  );
}
