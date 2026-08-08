"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
export default function VerifyEmailPage() {
  const [status, setStatus] = useState("Verifying your email…");
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setStatus("This verification link is missing its token.");
      return;
    }
    fetch(`${apiUrl}/auth/verify-email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }).then((response) =>
      setStatus(
        response.ok
          ? "Your email is verified."
          : "This verification link is invalid or expired.",
      ),
    );
  }, []);
  return (
    <main className="paper-grid min-h-screen bg-[#f4f6f2] p-6 text-emerald-950">
      <section className="mx-auto mt-24 max-w-md rounded-3xl bg-white p-8 shadow-xl">
        <h1 className="text-3xl font-black">Email verification</h1>
        <p className="mt-4 text-emerald-950/70">{status}</p>
        <Link
          href="/home"
          className="mt-6 inline-block font-bold text-emerald-800"
        >
          Continue to Tracera →
        </Link>
      </section>
    </main>
  );
}
