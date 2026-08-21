"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuth } from "./auth-provider";

type AppScreen = "home" | "hub" | "history";

const navigation: { href: string; label: string; screen: AppScreen }[] = [
  { href: "/home", label: "Analyze", screen: "home" },
  { href: "/hub", label: "News Hub", screen: "hub" },
  { href: "/history", label: "History", screen: "history" },
];

export function AppHeader({ active }: { active?: AppScreen }) {
  const { user, isLoading, signOut } = useAuth();
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <header className="app-header-panel sticky top-3 z-50 mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 rounded-2xl border border-emerald-950/10 bg-[#f4f6f2]/88 px-4 py-3 shadow-[0_16px_42px_-32px_rgba(16,34,31,.68)] backdrop-blur-xl sm:mt-5 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-x-2 sm:px-5">
      <Link
        href="/home"
        className="group col-start-1 row-start-1 block w-fit rounded-lg transition group-hover:-translate-y-0.5"
        aria-label="Tracera analysis home"
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
        className="col-span-2 col-start-1 row-start-2 grid grid-cols-3 rounded-xl bg-emerald-950/5 p-1 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:flex sm:items-center sm:gap-1 sm:rounded-full sm:bg-transparent sm:p-0"
        aria-label="Primary navigation"
      >
        {navigation.map((item) => (
          <Link
            key={item.screen}
            href={item.href}
            aria-current={active === item.screen ? "page" : undefined}
            className={`flex min-h-10 items-center justify-center whitespace-nowrap rounded-full px-3 py-2 text-sm font-bold transition sm:px-4 ${active === item.screen ? "bg-emerald-950 text-white shadow-sm" : "text-emerald-950/65 hover:bg-emerald-950/7 hover:text-emerald-950"}`}
          >
            {item.label}
          </Link>
        ))}
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
