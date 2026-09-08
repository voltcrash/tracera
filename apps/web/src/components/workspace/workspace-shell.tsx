"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Menu, Newspaper, PenLine, X } from "lucide-react";
import type { TraceSummary } from "@/app/(workspace)/hub/_components/trace-library";
import { BrandLockup } from "@/components/brand/brand-lockup";
import { useAuth } from "@/components/providers/auth-provider";
import { ThemeToggle } from "@/components/navigation/theme-toggle";
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
import { apiUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Lets a screen tell the rail that the history it is showing is now stale. */
const HistoryRefreshContext = createContext<() => void>(() => {});

export function useHistoryRefresh() {
  return useContext(HistoryRefreshContext);
}

export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const { apiFetch, isLoading: isAuthLoading, user } = useAuth();
  const [traces, setTraces] = useState<TraceSummary[] | null>(null);
  const [version, setVersion] = useState(0);
  const [railOpen, setRailOpen] = useState(false);

  const refresh = useCallback(() => setVersion((current) => current + 1), []);

  useEffect(() => {
    if (isAuthLoading || !user) return;
    const controller = new AbortController();
    apiFetch(`${apiUrl}/checks?scope=mine&page=1&pageSize=30`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load your traces.");
        const data = (await response.json()) as { checks: TraceSummary[] };
        setTraces(data.checks);
      })
      .catch(() => {
        if (!controller.signal.aborted) setTraces([]);
      });
    return () => controller.abort();
  }, [apiFetch, isAuthLoading, user, version]);

  return (
    <HistoryRefreshContext.Provider value={refresh}>
      <div className="workspace">
        <button
          type="button"
          className="rail-scrim"
          hidden={!railOpen}
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setRailOpen(false)}
        />
        <Rail
          traces={traces}
          isLoading={isAuthLoading || traces === null}
          open={railOpen}
          onClose={() => setRailOpen(false)}
        />
        <div className="workspace-canvas">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="rail-open-button"
            onClick={() => setRailOpen(true)}
            aria-label="Open traces"
          >
            <Menu />
          </Button>
          {children}
        </div>
      </div>
    </HistoryRefreshContext.Provider>
  );
}

function Rail({
  traces,
  isLoading,
  open,
  onClose,
}: {
  traces: TraceSummary[] | null;
  isLoading: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const groups = useMemo(() => groupByAge(traces ?? []), [traces]);

  return (
    <aside className="rail" data-open={open || undefined} aria-label="Traces">
      <div className="rail-head">
        <Link href="/home" aria-label="Tracera home" onClick={onClose}>
          <BrandLockup markClassName="h-7 w-7" className="h-8 text-xl" />
        </Link>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="rail-close-button"
          onClick={onClose}
          aria-label="Close traces"
        >
          <X />
        </Button>
      </div>

      {/* Navigating always dismisses the rail, which is off-canvas on small screens. */}
      <div className="rail-actions">
        <Link
          href="/home"
          onClick={onClose}
          className={cn("rail-link", pathname === "/home" && "rail-link-current")}
          aria-current={pathname === "/home" ? "page" : undefined}
        >
          <PenLine />
          New trace
        </Link>
        <Link
          href="/hub"
          onClick={onClose}
          className={cn("rail-link", pathname.startsWith("/hub") && "rail-link-current")}
          aria-current={pathname.startsWith("/hub") ? "page" : undefined}
        >
          <Newspaper />
          News Hub
        </Link>
      </div>

      <nav className="rail-history" aria-label="Your traces">
        {isLoading ? (
          <div className="rail-history-loading">
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <p className="rail-empty">Traces you run are kept here.</p>
        ) : (
          groups.map((group) => (
            <section key={group.label}>
              <h2 className="rail-group">{group.label}</h2>
              {group.traces.map((trace) => (
                <Link
                  key={trace.id}
                  href={`/hub/${trace.id}`}
                  onClick={onClose}
                  className="rail-trace"
                  aria-current={pathname === `/hub/${trace.id}` ? "page" : undefined}
                >
                  <span className="rail-trace-claim">{trace.rawInput}</span>
                  <span className="rail-trace-meta">
                    <span>{shortAge(trace.createdAt)}</span>
                    <span
                      className="rail-trace-score"
                      data-tone={scoreTone(trace.traceraScore.overall)}
                    >
                      {Math.round(trace.traceraScore.overall)}
                    </span>
                  </span>
                </Link>
              ))}
            </section>
          ))
        )}
      </nav>

      <RailAccount />
    </aside>
  );
}

function RailAccount() {
  const { user, isLoading, signOut } = useAuth();
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <div className="rail-foot">
      {isLoading || !user ? (
        <Skeleton className="h-10 flex-1 rounded-lg" aria-label="Loading account" />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<button type="button" className="rail-account" aria-label="Account" />}
          >
            <Avatar className="size-7">
              <AvatarFallback>{user.email.slice(0, 2)}</AvatarFallback>
            </Avatar>
            <span className="truncate">{user.email}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-56">
            <DropdownMenuLabel className="truncate text-muted-foreground">
              {user.email}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void handleSignOut()}>
              <LogOut />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <ThemeToggle className="size-9 shrink-0" />
    </div>
  );
}

function scoreTone(score: number) {
  return score >= 70 ? "strong" : score >= 45 ? "mixed" : "weak";
}

const DAY = 86_400_000;

function groupByAge(traces: TraceSummary[]) {
  const buckets: { label: string; traces: TraceSummary[] }[] = [
    { label: "Today", traces: [] },
    { label: "This week", traces: [] },
    { label: "Earlier", traces: [] },
  ];
  const now = Date.now();
  for (const trace of traces) {
    const age = now - new Date(trace.createdAt).getTime();
    const bucket = age < DAY ? 0 : age < 7 * DAY ? 1 : 2;
    buckets[bucket]!.traces.push(trace);
  }
  return buckets.filter((bucket) => bucket.traces.length > 0);
}

function shortAge(createdAt: string) {
  const created = new Date(createdAt);
  const minutes = Math.round((Date.now() - created.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  if (minutes < 10_080) return `${Math.round(minutes / 1440)}d ago`;
  return created.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
