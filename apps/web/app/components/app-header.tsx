"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { LogOut, ScanSearch, Newspaper } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useAuth } from "./auth-provider";

type AppScreen = "home" | "hub";

const navigation = [
  { href: "/home", label: "Analyze", screen: "home" as const, icon: ScanSearch },
  { href: "/hub", label: "News Hub", screen: "hub" as const, icon: Newspaper },
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
    <header className="sticky top-3 z-50 mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 rounded-2xl border border-border bg-background/85 px-4 py-3 shadow-[0_16px_42px_-32px_rgba(16,34,31,.68)] backdrop-blur-xl sm:mt-5 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-x-2 sm:px-5">
      <Link
        href="/home"
        className="col-start-1 row-start-1 block w-fit rounded-lg transition hover:-translate-y-0.5"
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
        className="col-span-2 col-start-1 row-start-2 grid grid-cols-2 gap-1 rounded-xl bg-primary/5 p-1 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:flex sm:items-center sm:rounded-full sm:bg-transparent sm:p-0"
        aria-label="Primary navigation"
      >
        {navigation.map((item) => (
          <Button
            key={item.screen}
            asChild
            variant={active === item.screen ? "default" : "ghost"}
            className={cn("rounded-full", active !== item.screen && "text-muted-foreground")}
          >
            <Link href={item.href} aria-current={active === item.screen ? "page" : undefined}>
              <item.icon />
              {item.label}
            </Link>
          </Button>
        ))}
      </nav>

      <div className="col-start-2 row-start-1 flex items-center justify-end sm:col-start-3">
        {isLoading ? (
          <Skeleton className="size-10 rounded-full" aria-label="Loading account" />
        ) : user ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="gap-2 rounded-full pl-1.5 pr-3"
                aria-label="Account menu"
              >
                <Avatar className="size-7">
                  <AvatarFallback>{user.email.slice(0, 2)}</AvatarFallback>
                </Avatar>
                <span className="hidden max-w-40 truncate text-muted-foreground lg:block">
                  {user.email}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuLabel className="truncate text-muted-foreground">
                {user.email}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void handleSignOut()}>
                <LogOut />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button asChild variant="outline" className="rounded-full">
            <Link href="/login">Log in</Link>
          </Button>
        )}
      </div>
    </header>
  );
}
