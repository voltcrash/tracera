"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { useAuth } from "@/components/providers/auth-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const notes = [
  {
    marker: "1",
    verdict: "Supported",
    tone: "text-lime-ink",
    body: "The department's own dataset gives the 40% figure, and three independent reports match it.",
  },
  {
    marker: "2",
    verdict: "Not a claim",
    tone: "text-ink-faint",
    body: "Attributed to ministers rather than stated as fact, so it stays out of the score.",
  },
  {
    marker: "3",
    verdict: "Needs context",
    tone: "text-tint-amber-foreground",
    body: "40% is the average. The same table shows 9% for the lowest-income quartile.",
  },
];

const trail = [
  {
    when: "Today, 09:42",
    source: "Aggregator repost",
    detail: "No new reporting. Links back to yesterday's write-up.",
  },
  {
    when: "Yesterday, 18:10",
    source: "Regional paper",
    detail: "First article to quote the 40% figure, without the quartile breakdown.",
  },
  {
    when: "14 May, 08:00",
    source: "Department dataset",
    detail: "Table 3 is where the figure comes from.",
    origin: true,
  },
];

const scoreParts = [
  { label: "Source reputation", value: 91 },
  { label: "Recency of evidence", value: 84 },
  { label: "Corroboration across sources", value: 78 },
  { label: "Evidence quality", value: 72 },
  { label: "Neutral language", value: 58 },
];

/** Same bands the hub scores against, so a part reads the same wherever it appears. */
function scoreTone(value: number) {
  return value >= 70 ? "strong" : value >= 45 ? "mixed" : "weak";
}

export default function LandingPage() {
  const { user } = useAuth();
  const router = useRouter();
  const googleCtaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (user) router.replace("/home");
  }, [router, user]);

  function showGoogleSignIn() {
    const googleCta = googleCtaRef.current;
    if (!googleCta) return;

    googleCta.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    });
    googleCta.classList.remove("google-cta-highlight");
    void googleCta.offsetWidth;
    googleCta.classList.add("google-cta-highlight");
  }

  return (
    <main className="doc min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b border-line bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" aria-label="Tracera home">
            <Image
              src="/brand/tracera-wordmark-cropped.png"
              alt="Tracera"
              width={148}
              height={34}
              priority
              className="brand-wordmark h-7 w-auto"
            />
          </Link>
          <div className="flex items-center gap-5">
            <nav className="hidden items-center gap-5 text-sm text-ink-soft sm:flex">
              <a href="#trail" className="hover:text-foreground">
                Where a story starts
              </a>
              <a href="#score" className="hover:text-foreground">
                The score
              </a>
            </nav>
            <Button
              type="button"
              variant="outline"
              className="color-sweep-button login-cta rounded-full px-5"
              onClick={showGoogleSignIn}
            >
              Try Tracera
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6">
        <section className="pb-20 pt-16 sm:pt-20">
          <h1 className="max-w-[18ch] font-serif text-5xl leading-[1.05] tracking-[-0.02em] sm:text-6xl">
            Every story is a stack of claims.
          </h1>
          <p className="mt-6 max-w-[58ch] text-lg leading-8 text-ink-soft">
            Tracera takes them apart one at a time, checks each against sources it can name, and
            marks the ones that don&rsquo;t hold up.
          </p>

          <div className="mt-14 grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-14">
            <div>
              <p className="text-sm text-ink-faint">Sample excerpt, as Tracera marks it</p>
              <blockquote className="mt-4 font-serif text-2xl leading-[1.6] sm:text-[1.7rem] sm:leading-[1.62]">
                &ldquo;New research shows the policy{" "}
                <span
                  className="claim claim-supported"
                  style={{ "--claim-delay": "500ms" } as CSSProperties}
                >
                  cut household energy costs by 40% in its first year
                  <span className="claim-marker">1</span>
                </span>
                , and{" "}
                <span
                  className="claim claim-framing"
                  style={{ "--claim-delay": "700ms" } as CSSProperties}
                >
                  ministers say
                  <span className="claim-marker">2</span>
                </span>{" "}
                <span
                  className="claim claim-context"
                  style={{ "--claim-delay": "900ms" } as CSSProperties}
                >
                  every home will feel the benefit before winter, no matter where they live or what
                  they earn
                  <span className="claim-marker">3</span>
                </span>
                .&rdquo;
              </blockquote>

              <p className="mt-10 text-sm text-ink-faint">
                Paste the text, drop the link, or upload a screenshot.
              </p>
              <div id="try-tracera" ref={googleCtaRef} className="mt-5 inline-flex rounded-2xl">
                <GoogleSignInButton
                  label="Continue with Google"
                  showGoogleMark
                  variant="brand"
                  size="lg"
                  className="color-sweep-button"
                />
              </div>
            </div>

            <div className="space-y-7 border-t border-line pt-7 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-1">
              {notes.map((note, index) => (
                <div
                  key={note.marker}
                  className="note grid grid-cols-[1.25rem_1fr] gap-x-2"
                  style={{ "--note-delay": `${1150 + index * 160}ms` } as CSSProperties}
                >
                  <span className={cn("text-sm font-bold", note.tone)}>{note.marker}</span>
                  <div>
                    <p className={cn("text-sm font-bold", note.tone)}>{note.verdict}</p>
                    <p className="mt-1 text-sm leading-6 text-ink-soft">{note.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="trail" className="scroll-mt-8 border-t border-line py-20">
          <h2 className="max-w-[20ch] font-serif text-4xl leading-[1.1] tracking-[-0.02em]">
            The version you read is rarely the first one.
          </h2>
          <p className="mt-5 max-w-[60ch] text-base leading-7 text-ink-soft">
            Tracera walks a story back through the reposts and rewrites to the earliest source it
            can find, and says so plainly when the trail runs cold.
          </p>

          <div className="mt-12">
            {trail.map((entry) => (
              <div
                key={entry.source}
                className="trail-entry grid gap-1 py-5 sm:grid-cols-[10rem_1fr] sm:gap-6"
              >
                <p className="text-sm text-ink-faint sm:pt-0.5">{entry.when}</p>
                <div>
                  <p className="font-serif text-xl">
                    {entry.source}
                    {entry.origin ? (
                      <span className="ml-3 align-middle text-xs font-bold text-lime-ink font-sans">
                        Earliest found
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 max-w-[58ch] text-sm leading-6 text-ink-soft">
                    {entry.detail}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section id="score" className="scroll-mt-8 border-t border-line py-20">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-20">
            <div>
              <h2 className="font-serif text-4xl leading-[1.1] tracking-[-0.02em]">
                One number, kept in pieces.
              </h2>
              <p className="mt-5 max-w-[46ch] text-base leading-7 text-ink-soft">
                A single score is easy to wave away, so Tracera leaves its parts on the page.
                Reputable sources don&rsquo;t cover for thin evidence &mdash; each part is measured
                on its own.
              </p>
              <p className="mt-6 max-w-[46ch] text-sm leading-6 text-ink-faint">
                The score describes what Tracera found. It is not a ruling on whether the story is
                true.
              </p>
            </div>

            <ul className="self-center">
              {scoreParts.map((part) => (
                <li key={part.label} className="py-4">
                  <div className="flex items-baseline justify-between gap-6">
                    <span className="text-sm text-ink-soft">{part.label}</span>
                    <span className="font-serif text-lg tabular-nums">{part.value}</span>
                  </div>
                  <span className="score-rule mt-2.5" data-tone={scoreTone(part.value)}>
                    <span style={{ width: `${part.value}%` }} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      <section className="bg-panel text-panel-foreground">
        <div className="mx-auto max-w-5xl px-6 py-24">
          <h2 className="max-w-[16ch] font-serif text-4xl leading-[1.1] tracking-[-0.02em] sm:text-5xl">
            Bring something you&rsquo;re not sure about.
          </h2>
          <div className="mt-10">
            <Button
              type="button"
              variant="outline"
              className="color-sweep-button login-cta rounded-full px-5"
              onClick={showGoogleSignIn}
            >
              Try Tracera
            </Button>
          </div>
          <p className="mt-8 max-w-[56ch] text-sm leading-6 text-panel-muted">
            Tracera is automated, and it can be wrong. Every claim it marks shows the sources behind
            it, so you can check the check.
          </p>
        </div>
      </section>
    </main>
  );
}
