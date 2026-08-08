"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default function ResetPasswordPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const token =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("token");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const response = await fetch(
      `${apiUrl}/auth/${token ? "reset-password" : "forgot-password"}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(token ? { token, password } : { email }),
      },
    );
    const data = await response.json().catch(() => ({}));
    setStatus(
      response.ok
        ? token
          ? "Your password was reset. You can now log in."
          : "If that account exists, a reset link is on its way."
        : (data.error ?? "Could not complete that request."),
    );
  }
  return (
    <main className="paper-grid min-h-screen bg-[#f4f6f2] p-6 text-emerald-950">
      <section className="mx-auto mt-24 max-w-md rounded-3xl bg-white p-8 shadow-xl">
        <Link href="/login" className="text-sm font-bold text-emerald-800">
          ← Back to login
        </Link>
        <h1 className="mt-6 text-3xl font-black">
          {token ? "Choose a new password" : "Reset your password"}
        </h1>
        <form onSubmit={submit} className="mt-6 space-y-4">
          {token ? (
            <input
              className="w-full rounded-xl border p-3"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              minLength={8}
              placeholder="New password"
              required
            />
          ) : (
            <input
              className="w-full rounded-xl border p-3"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              placeholder="you@example.com"
              required
            />
          )}
          <button className="w-full rounded-xl bg-emerald-950 p-3 font-black text-white">
            Continue
          </button>
        </form>
        {status && <p className="mt-4 text-sm text-emerald-800">{status}</p>}
      </section>
    </main>
  );
}
