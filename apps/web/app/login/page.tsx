"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { type AuthUser, useAuth } from "../components/auth-provider";

const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001").replace(/\/$/, "");

export default function LoginPage() {
  const router = useRouter();
  const { user, isLoading, setUser } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && user) router.replace("/home");
  }, [isLoading, router, user]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`${apiUrl}/auth/${mode === "login" ? "login" : "signup"}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await response.json()) as { user?: AuthUser; error?: string };
      if (!response.ok || !data.user) throw new Error(data.error ?? "Unable to continue.");
      setUser(data.user);
      router.replace("/home");
      router.refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to continue.");
    } finally {
      setSubmitting(false);
    }
  }

  const signingUp = mode === "signup";
  return (
    <main className="grid min-h-screen bg-[#f7faf9] lg:grid-cols-2">
      <section className="hidden bg-emerald-950 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <Link href="/" className="text-lg font-extrabold tracking-tight">tracera<span className="text-[#9cf0d1]">.</span></Link>
        <div><p className="text-xs font-black tracking-[.18em] text-[#9cf0d1]">EVIDENCE, NOT ECHOES</p><h1 className="mt-5 max-w-md text-5xl font-extrabold leading-[1.05] tracking-[-.04em]">Less noise. Better judgment.</h1><p className="mt-6 max-w-md text-lg leading-8 text-white/70">Save analyses, follow how a story changes, and build a clearer picture of the information you encounter.</p></div>
        <p className="text-sm text-white/50">Email and password only. No social sign-in or two-factor setup.</p>
      </section>
      <section className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md"><Link href="/" className="text-sm font-semibold text-slate-500 hover:text-slate-950">← Back to Tracera</Link>
          <p className="mt-12 text-[10px] font-black tracking-[.2em] text-emerald-700">YOUR TRACERA ACCOUNT</p>
          <h1 className="mt-3 text-3xl font-extrabold tracking-[-.03em]">{signingUp ? "Create your account" : "Welcome back"}</h1>
          <p className="mt-2 text-slate-600">{signingUp ? "Save your evidence trails in one place." : "Sign in to continue your evidence trail."}</p>
          <form className="mt-8 space-y-4" onSubmit={submit}>
            <label className="block text-sm font-semibold text-slate-700">Email<input autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required type="email" placeholder="you@example.com" className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-4 py-3 outline-none focus:border-emerald-600 focus:ring-4 focus:ring-emerald-50" /></label>
            <label className="block text-sm font-semibold text-slate-700">Password<input autoComplete={signingUp ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} maxLength={128} type="password" placeholder="At least 8 characters" className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-4 py-3 outline-none focus:border-emerald-600 focus:ring-4 focus:ring-emerald-50" /></label>
            {error ? <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">{error}</p> : null}
            <button disabled={submitting} className="w-full rounded-xl bg-emerald-800 py-3 text-sm font-bold text-white transition hover:bg-emerald-950 disabled:cursor-not-allowed disabled:bg-slate-400">{submitting ? "Please wait…" : signingUp ? "Create account" : "Sign in"}</button>
          </form>
          <p className="mt-8 text-center text-sm text-slate-500">{signingUp ? "Already have an account?" : "New to Tracera?"} <button type="button" onClick={() => { setMode(signingUp ? "login" : "signup"); setError(null); }} className="font-semibold text-emerald-700 hover:text-emerald-900">{signingUp ? "Sign in" : "Create an account"}</button></p>
        </div>
      </section>
    </main>
  );
}
