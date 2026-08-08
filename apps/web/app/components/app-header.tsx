"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuth } from "./auth-provider";

export function AppHeader({ active }: { active?: "home" | "hub" }) {
  const { user, isLoading, signOut } = useAuth();
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <header className="flex items-center justify-between border-b border-emerald-950/10 py-5">
      <Link
        href="/"
        className="group block rounded-lg transition group-hover:-translate-y-0.5"
        aria-label="Tracera home"
      >
        <Image src="/brand/tracera-wordmark-cropped.png" alt="Tracera" width={148} height={34} priority className="h-8 w-auto" />
      </Link>
      <nav className="flex items-center gap-1" aria-label="Primary navigation">
        <Link
          href="/home"
          className={`rounded-full px-3.5 py-2 text-sm font-semibold transition ${active === "home" ? "bg-emerald-950 text-white shadow-sm" : "text-emerald-950/65 hover:bg-emerald-950/7 hover:text-emerald-950"}`}
        >
          Analyze
        </Link>
        <Link
          href="/hub"
          className={`rounded-full px-3.5 py-2 text-sm font-semibold transition ${active === "hub" ? "bg-emerald-950 text-white shadow-sm" : "text-emerald-950/65 hover:bg-emerald-950/7 hover:text-emerald-950"}`}
        >
          News Hub
        </Link>
        {isLoading ? <span className="ml-2 size-9 animate-pulse rounded-full bg-emerald-950/10" aria-label="Loading account" /> : user ? <div className="ml-2 flex items-center gap-2"><span className="hidden max-w-40 truncate text-sm font-semibold text-emerald-950/65 sm:block" title={user.email}>{user.email}</span><button type="button" onClick={() => void handleSignOut()} className="rounded-full border border-emerald-950/15 bg-white px-3 py-2 text-xs font-bold text-emerald-950 transition hover:-translate-y-0.5 hover:border-emerald-950">Log out</button></div> : <Link href="/login" className="ml-2 rounded-full border border-emerald-950/15 bg-white px-3.5 py-2 text-sm font-bold text-emerald-950 transition hover:-translate-y-0.5 hover:border-emerald-950">Log in</Link>}
      </nav>
    </header>
  );
}
