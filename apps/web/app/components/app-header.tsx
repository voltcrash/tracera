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
    <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 border-b border-emerald-950/10 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-x-2 sm:py-5">
      <Link
        href="/"
        className="group col-start-1 row-start-1 block w-fit rounded-lg transition group-hover:-translate-y-0.5"
        aria-label="Tracera home"
      >
        <Image
          src="/brand/tracera-wordmark-cropped.png"
          alt="Tracera"
          width={148}
          height={34}
          priority
          className="h-7 w-auto sm:h-8"
        />
      </Link>
      <nav
        className="col-span-2 col-start-1 row-start-2 grid grid-cols-2 rounded-full bg-emerald-950/5 p-1 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:flex sm:items-center sm:gap-1 sm:bg-transparent sm:p-0"
        aria-label="Primary navigation"
      >
        <Link
          href="/home"
          aria-current={active === "home" ? "page" : undefined}
          className={`flex min-h-10 items-center justify-center whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold transition ${active === "home" ? "bg-emerald-950 text-white shadow-sm" : "text-emerald-950/65 hover:bg-emerald-950/7 hover:text-emerald-950"}`}
        >
          Analyze
        </Link>
        <Link
          href="/hub"
          aria-current={active === "hub" ? "page" : undefined}
          className={`flex min-h-10 items-center justify-center whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold transition ${active === "hub" ? "bg-emerald-950 text-white shadow-sm" : "text-emerald-950/65 hover:bg-emerald-950/7 hover:text-emerald-950"}`}
        >
          News Hub
        </Link>
      </nav>
      <div className="col-start-2 row-start-1 flex items-center justify-end sm:col-start-3">
        {isLoading ? (
          <span
            className="size-10 animate-pulse rounded-full bg-emerald-950/10"
            aria-label="Loading account"
          />
        ) : user ? (
          <div className="flex items-center gap-2">
            <span
              className="hidden max-w-40 truncate text-sm font-semibold text-emerald-950/65 lg:block"
              title={user.email}
            >
              {user.email}
            </span>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="flex min-h-10 items-center whitespace-nowrap rounded-full border border-emerald-950/15 bg-white px-3.5 py-2 text-sm font-bold text-emerald-950 transition hover:-translate-y-0.5 hover:border-emerald-950"
            >
              Log out
            </button>
          </div>
        ) : (
          <Link
            href="/login"
            className="flex min-h-10 items-center whitespace-nowrap rounded-full border border-emerald-950/15 bg-white px-3.5 py-2 text-sm font-bold text-emerald-950 transition hover:-translate-y-0.5 hover:border-emerald-950"
          >
            Log in
          </Link>
        )}
      </div>
    </header>
  );
}
