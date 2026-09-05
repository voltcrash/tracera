"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Check, Search } from "lucide-react";
import { LandingEvidenceGraph } from "./_components/landing-evidence-graph";
import { ThemeToggle } from "@/components/navigation/theme-toggle";
import { useAuth } from "@/components/providers/auth-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const scoreDimensions = [
  { label: "Factual accuracy", value: 86, color: "bg-chart-1" },
  { label: "Source corroboration", value: 78, color: "bg-chart-2" },
  { label: "Evidence quality", value: 72, color: "bg-chart-4" },
  { label: "Source reputation", value: 91, color: "bg-chart-5" },
  { label: "Framing & language", value: 64, color: "bg-chart-3" },
];

export default function LandingPage() {
  const { user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user) router.replace("/home");
  }, [router, user]);

  return (
    <main className="landing-page paper-grid min-h-screen overflow-hidden bg-background text-foreground">
      <div className="landing-aurora landing-aurora-one" aria-hidden="true" />
      <div className="landing-aurora landing-aurora-two" aria-hidden="true" />

      <div className="relative z-10 mx-auto max-w-7xl px-5 sm:px-8">
        <header className="landing-nav mt-3 flex items-center justify-between rounded-2xl border border-line bg-background/85 px-4 py-3 shadow-(--shadow-nav) backdrop-blur-xl sm:mt-5 sm:px-5">
          <Link
            href="/"
            className="group block rounded-lg transition hover:-translate-y-0.5"
            aria-label="Tracera home"
          >
            <Image
              src="/brand/tracera-wordmark-cropped.png"
              alt="Tracera"
              width={148}
              height={34}
              priority
              className="brand-wordmark h-7 w-auto sm:h-8"
            />
          </Link>
          <nav className="hidden items-center gap-1 md:flex" aria-label="Primary navigation">
            <a href="#features" className="landing-nav-link">
              Features
            </a>
            <a href="#how-it-works" className="landing-nav-link">
              How it works
            </a>
            <a href="#living-traces" className="landing-nav-link">
              Living traces
            </a>
            <Link href="/hub" className="landing-nav-link">
              News Hub
            </Link>
          </nav>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <ThemeToggle />
            <Button
              render={<Link href="/login" />}
              variant="ghost"
              className="hidden rounded-full sm:inline-flex"
            >
              Log in
            </Button>
            <Button render={<Link href="/home" />} variant="brand">
              Start a trace
            </Button>
          </div>
        </header>

        <section className="grid gap-12 pb-20 pt-20 sm:pb-28 sm:pt-28 lg:grid-cols-[1.08fr_.92fr] lg:items-center lg:gap-16 lg:pt-32">
          <div className="landing-reveal">
            <h1 className="max-w-4xl text-[3.55rem] font-black leading-[.88] tracking-[-.085em] sm:text-7xl lg:text-[5.8rem]">
              Don&apos;t just read the story.
              <span className="landing-highlight relative mt-2 block w-fit text-emerald">
                Trace it.
              </span>
            </h1>
            <p className="mt-8 max-w-xl text-lg leading-8 text-ink/65 sm:text-xl sm:leading-9">
              Tracera pulls news apart into checkable claims, follows each one back to its sources,
              and shows you exactly where confidence comes from.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Button render={<Link href="/home" />} variant="brand" size="xl">
                Check a story
              </Button>
              <Button render={<Link href="/hub" />} variant="outline" size="xl">
                Explore live traces
              </Button>
            </div>
            <div className="mt-10 flex flex-wrap gap-x-7 gap-y-3 text-xs font-bold text-ink/52">
              <span className="landing-check">Text, links & images</span>
              <span className="landing-check">Claim-level evidence</span>
              <span className="landing-check">Private by choice</span>
            </div>
          </div>

          <div className="landing-reveal landing-reveal-delay relative">
            <div className="landing-float-tag landing-float-tag-top" aria-hidden="true">
              <span className="size-2 rounded-full bg-emerald-500" /> 4 sources agree
            </div>
            <LandingEvidenceGraph />
            <div className="landing-float-tag landing-float-tag-bottom" aria-hidden="true">
              <span className="font-black text-tint-amber-foreground">△</span> Context gap found
            </div>
          </div>
        </section>

        <section
          aria-label="What Tracera analyzes"
          className="landing-signal-strip mb-24 grid overflow-hidden rounded-3xl border border-line bg-glass-weak shadow-(--shadow-card) sm:grid-cols-2 lg:mb-32 lg:grid-cols-4"
        >
          <SignalStat number="01" label="Break apart" detail="Atomic, checkable claims" />
          <SignalStat number="02" label="Follow back" detail="Origins and source trails" />
          <SignalStat number="03" label="Cross-check" detail="Support and contradiction" />
          <SignalStat number="04" label="Preserve context" detail="Trace history" />
        </section>

        <section id="features" className="scroll-mt-24 py-10 sm:py-16">
          <SectionIntro
            title="More useful than a verdict. More honest than a score alone."
            copy="Every Tracera check is designed to be inspected. See the claim, the sources, the gaps, the reasoning, and what changed—without losing the shape of the original story."
          />

          <div className="mt-14 grid gap-5 lg:grid-cols-12">
            <article className="feature-card landing-view-reveal lg:col-span-7">
              <FeatureHeading title="Bring the news in whatever form it finds you." />
              <div className="mt-9 grid gap-5 sm:grid-cols-[.75fr_1.25fr] sm:items-end">
                <div className="space-y-3">
                  <FormatRow icon="Aa" label="Paste text" status="Ready" active />
                  <FormatRow icon="↗" label="Drop a link" status="Detected" />
                  <FormatRow icon="◫" label="Add an image" status="OCR + metadata" />
                </div>
                <div className="relative overflow-hidden rounded-2xl bg-sunken p-5">
                  <div className="mb-4 flex items-center gap-1.5" aria-hidden="true">
                    <span className="size-2 rounded-full bg-rose-300" />
                    <span className="size-2 rounded-full bg-amber-300" />
                    <span className="size-2 rounded-full bg-emerald-300" />
                  </div>
                  <p className="text-sm font-semibold leading-6 text-ink/65">
                    “New research shows the policy cut household energy costs by 40% in its first
                    year...”
                  </p>
                  <div className="mt-5 flex items-center justify-between gap-3 border-t border-line-weak pt-4">
                    <span className="text-xs font-semibold text-emerald">Link found</span>
                    <span className="rounded-lg bg-panel px-3 py-2 text-xs font-semibold text-panel-foreground">
                      Trace evidence
                    </span>
                  </div>
                  <span className="landing-scan-line" aria-hidden="true" />
                </div>
              </div>
            </article>

            <article className="feature-card-dark landing-view-reveal lg:col-span-5">
              <FeatureHeading title="One score. Five visible signals." dark />
              <div className="mt-7 grid grid-cols-[auto_1fr] items-center gap-6">
                <div className="score-orbit">
                  <div>
                    <strong>82</strong>
                    <span>/100</span>
                  </div>
                </div>
                <div className="space-y-3">
                  {scoreDimensions.map((dimension) => (
                    <MiniScore key={dimension.label} {...dimension} />
                  ))}
                </div>
              </div>
              <p className="mt-7 border-t border-white/10 pt-5 text-sm leading-6 text-white/58">
                Strong sources can&apos;t hide weak evidence. Each signal stays separate and
                readable.
              </p>
            </article>

            <article className="feature-card landing-view-reveal lg:col-span-5">
              <FeatureHeading title="No more all-or-nothing fact checks." />
              <p className="mt-4 text-sm leading-6 text-ink/58">
                Tracera separates fact from framing, then gives every checkable claim its own
                verdict.
              </p>
              <div className="mt-7 space-y-3">
                <Claim
                  label="The policy was announced this week"
                  verdict="Supported"
                  tone="emerald"
                />
                <Claim
                  label="It benefits every household equally"
                  verdict="Needs context"
                  tone="amber"
                />
                <Claim label="Savings begin immediately" verdict="Inconclusive" tone="slate" />
              </div>
            </article>

            <article className="feature-card feature-card-mint landing-view-reveal lg:col-span-7">
              <div className="grid gap-8 sm:grid-cols-[.8fr_1.2fr] sm:items-center">
                <FeatureHeading title="Follow the story back to where it started." />
                <div className="source-trail" aria-label="Example source trail">
                  <SourceNode date="Today · 09:42" source="News repost" state="late" />
                  <SourceNode date="Yesterday · 18:10" source="Local report" state="middle" />
                  <SourceNode date="May 14 · 08:00" source="Primary record" state="origin" />
                </div>
              </div>
              <p className="mt-7 max-w-2xl text-sm leading-6 text-ink/62">
                Rewrites and citations are useful—but the earliest known report, dataset, or public
                record is where context often changes.
              </p>
            </article>

            <article className="feature-card landing-view-reveal lg:col-span-7">
              <FeatureHeading title="See agreement, conflict, and uncertainty side by side." />
              <div className="mt-8 grid gap-3 sm:grid-cols-3">
                <EvidenceColumn
                  tone="support"
                  count="04"
                  label="Supporting"
                  sources={["Public dataset", "Independent report"]}
                />
                <EvidenceColumn
                  tone="conflict"
                  count="01"
                  label="Conflicting"
                  sources={["Earlier estimate", "Method disputed"]}
                />
                <EvidenceColumn
                  tone="open"
                  count="02"
                  label="Inconclusive"
                  sources={["No primary record", "Recent claim"]}
                />
              </div>
            </article>

            <article className="feature-card feature-card-lilac landing-view-reveal lg:col-span-5">
              <FeatureHeading title="Know how good the evidence really is." />
              <div className="mt-8 rounded-2xl border border-line bg-glass-weak p-5">
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <p className="text-sm text-tint-lilac-foreground/85">Evidence quality</p>
                    <p className="mt-1 text-4xl font-black tracking-[-.07em] text-tint-lilac-foreground">
                      72
                      <span className="text-base text-tint-lilac-foreground/55">/100</span>
                    </p>
                  </div>
                  <span className="rounded-full bg-tint-lilac px-3 py-1 text-xs font-black text-tint-lilac-foreground">
                    Moderate
                  </span>
                </div>
                <div className="mt-5 h-2 overflow-hidden rounded-full bg-line-weak">
                  <span className="block h-full w-[72%] rounded-full bg-chart-3" />
                </div>
                <p className="mt-4 text-xs leading-5 text-tint-lilac-foreground/75">
                  Recent and relevant, with one missing primary source.
                </p>
              </div>
            </article>
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-24 py-24 sm:py-32">
          <div className="grid gap-14 lg:grid-cols-[.75fr_1.25fr] lg:gap-20">
            <div className="lg:sticky lg:top-32 lg:self-start">
              <h2 className="max-w-lg text-4xl font-black leading-[.96] tracking-[-.065em] sm:text-5xl">
                A clear answer without skipping the hard parts.
              </h2>
              <p className="mt-6 max-w-[52ch] text-base leading-relaxed text-ink/60">
                Tracera does the source work in stages, then keeps the full path open for you to
                inspect.
              </p>
              <Button
                render={<Link href="/home" />}
                variant="link"
                size="lg"
                className="mt-8 -ml-6"
              >
                Try it with a story
              </Button>
            </div>
            <ol className="space-y-5">
              <ProcessStep
                number="01"
                title="Separate the claims"
                copy="The story is normalized, factual statements are isolated, and opinion or framing is identified instead of quietly mixed into the verdict."
                label="CLAIMS"
                accent="bg-tint-mint text-tint-mint-foreground"
              />
              <ProcessStep
                number="02"
                title="Retrieve and audit evidence"
                copy="Relevant reporting, public records, fact checks, and related verified claims are gathered, ranked, and compared for support or contradiction."
                label="SOURCES"
                accent="bg-tint-amber text-tint-amber-foreground"
              />
              <ProcessStep
                number="03"
                title="Explain the result"
                copy="Each claim receives a verdict, reasoning, confidence, and evidence-quality assessment before those signals roll up into the Tracera Score."
                label="VERDICT"
                accent="bg-tint-lilac text-tint-lilac-foreground"
              />
            </ol>
          </div>
        </section>
      </div>

      <section
        id="living-traces"
        className="relative scroll-mt-20 overflow-hidden bg-panel py-24 text-white sm:py-32"
      >
        <div className="living-grid" aria-hidden="true" />
        <div className="relative z-10 mx-auto max-w-7xl px-5 sm:px-8">
          <div className="grid gap-14 lg:grid-cols-[.82fr_1.18fr] lg:items-center lg:gap-20">
            <div>
              <h2 className="max-w-xl text-4xl font-black leading-[.95] tracking-[-.065em] sm:text-6xl">
                The story moved. Your understanding should too.
              </h2>
              <p className="mt-6 max-w-[54ch] text-base leading-relaxed text-white/65 sm:text-lg">
                News rarely ends at publish. Tracera recognizes reappearances and preserves past
                checks, so each new analysis keeps its context.
              </p>
              <div className="mt-9 grid gap-3 sm:grid-cols-2">
                <DarkFeature
                  icon="≋"
                  title="Trace history"
                  copy="See every version instead of overwriting the past."
                />
                <DarkFeature
                  icon="◎"
                  title="Story reappearances"
                  copy="Recognize when the same claim returns in a new wrapper."
                />
              </div>
            </div>

            <div className="relative mx-auto w-full max-w-2xl">
              <div className="trace-window noise relative overflow-hidden rounded-[2rem] border border-white/12 bg-white/[.07] p-5 shadow-[0_35px_90px_-35px_rgba(0,0,0,.8)] backdrop-blur sm:p-7">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-5">
                  <div>
                    <p className="font-bold text-white/90">Household energy policy impact</p>
                    <p className="mt-1 text-sm text-white/45">Trace 0284</p>
                  </div>
                  <span className="inline-flex items-center gap-2 rounded-full bg-mint/12 px-3 py-1.5 text-xs font-semibold text-mint">
                    <span className="landing-status-dot" /> Following
                  </span>
                </div>
                <div className="mt-7 grid gap-6 sm:grid-cols-[1fr_auto]">
                  <div className="trace-timeline">
                    <TraceEvent
                      date="Today · 11:08"
                      title="Two new reports corroborate the record"
                      detail="Evidence quality increased"
                      score="82"
                      change="+9"
                      active
                    />
                    <TraceEvent
                      date="3 days ago"
                      title="Primary dataset published"
                      detail="Ground Zero updated"
                      score="73"
                      change="+5"
                    />
                    <TraceEvent
                      date="Last week"
                      title="Story first checked"
                      detail="Initial evidence was incomplete"
                      score="68"
                      change="NEW"
                    />
                  </div>
                  <div className="flex min-w-40 flex-col justify-between rounded-2xl bg-white/[.07] p-5">
                    <div>
                      <p className="text-sm text-white/45">Current score</p>
                      <p className="mt-2 text-5xl font-black tracking-[-.08em] text-mint">82</p>
                    </div>
                    <div className="mt-8">
                      <p className="text-xs font-bold text-white/55">Since first trace</p>
                      <p className="mt-1 text-xl font-black text-mint">+14 points</p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="trace-notification" aria-hidden="true">
                <span className="grid size-9 place-items-center rounded-xl bg-tint-mint text-tint-mint-foreground">
                  ↗
                </span>
                <span>
                  <strong>Evidence update</strong>
                  <small>Score rose from 73 to 82</small>
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <section className="py-24 sm:py-32">
          <SectionIntro
            title="Every good check makes the next one smarter."
            copy="Tracera’s verified claims corpus recognizes repeated narratives, finds related context, and avoids doing the same work from scratch—while still rechecking when freshness matters."
          />
          <div className="mt-14 grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
            <article className="feature-card overflow-hidden landing-view-reveal">
              <FeatureHeading title="Related context, already connected." />
              <div className="corpus-map mt-10" aria-label="Related claims knowledge map">
                <CorpusNode
                  className="corpus-node-main"
                  title="Current claim"
                  meta="Checking now"
                />
                <CorpusNode
                  className="corpus-node-one"
                  title="Prior verified claim"
                  meta="82% semantic match"
                />
                <CorpusNode
                  className="corpus-node-two"
                  title="Earlier wording"
                  meta="Same primary source"
                />
                <CorpusNode
                  className="corpus-node-three"
                  title="New evidence"
                  meta="Published today"
                />
                <span className="corpus-line corpus-line-one" />
                <span className="corpus-line corpus-line-two" />
                <span className="corpus-line corpus-line-three" />
              </div>
              <div className="mt-7 grid gap-3 border-t border-line-weak pt-6 sm:grid-cols-3">
                <CorpusMetric value="Instant" label="duplicate detection" />
                <CorpusMetric value="Stored" label="past trace versions" />
                <CorpusMetric value="Linked" label="related context" />
              </div>
            </article>

            <article className="feature-card feature-card-peach landing-view-reveal">
              <FeatureHeading title="A public record of how stories evolve." />
              <p className="mt-5 text-sm leading-6 text-ink/62">
                Search previous checks, filter high-confidence results, revisit source trails, and
                follow a trace from its first verdict to its latest evidence.
              </p>
              <div className="mt-8 rounded-2xl bg-glass-weak p-4 shadow-sm">
                <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
                  <Search className="size-4" /> Search claims and stories
                </div>
                <div className="mt-4 space-y-3">
                  <HubRow
                    score="89"
                    title="Public health funding report"
                    status="High confidence"
                  />
                  <HubRow score="74" title="Regional energy policy claim" status="Updated today" />
                  <HubRow score="61" title="Viral climate infographic" status="Review due" />
                </div>
              </div>
              <Button render={<Link href="/hub" />} variant="link" size="lg" className="mt-7 -ml-6">
                Explore the News Hub
              </Button>
            </article>
          </div>
        </section>

        <section className="landing-cta relative mb-8 overflow-hidden rounded-[2.5rem] bg-cta px-6 py-16 text-center text-cta-foreground sm:px-12 sm:py-20">
          <div className="cta-ring cta-ring-one" aria-hidden="true" />
          <div className="cta-ring cta-ring-two" aria-hidden="true" />
          <div className="relative z-10 mx-auto max-w-3xl">
            <h2 className="text-4xl font-black leading-[.92] tracking-[-.07em] sm:text-6xl">
              See what holds up.
              <br />
              See what&apos;s missing.
            </h2>
            <p className="mx-auto mt-6 max-w-[52ch] text-base leading-relaxed text-cta-foreground/70">
              Paste a headline, article, claim, link, or image. Tracera will take it from there.
            </p>
            <Button render={<Link href="/home" />} variant="brand" size="xl" className="mt-9">
              Start your first trace
            </Button>
          </div>
        </section>

        <footer className="flex flex-col gap-6 py-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center">
            <Image
              src="/brand/tracera-wordmark-cropped.png"
              alt="Tracera"
              width={126}
              height={29}
              className="brand-wordmark h-7 w-auto"
            />
          </div>
          <nav
            className="flex flex-wrap gap-x-6 gap-y-2 text-xs font-bold text-ink/55"
            aria-label="Footer navigation"
          >
            <a href="#features" className="hover:text-emerald">
              Features
            </a>
            <a href="#how-it-works" className="hover:text-emerald">
              How it works
            </a>
            <Link href="/hub" className="hover:text-emerald">
              News Hub
            </Link>
            <Link href="/login" className="hover:text-emerald">
              Log in
            </Link>
          </nav>
        </footer>
      </div>
    </main>
  );
}

function SectionIntro({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_.8fr] lg:items-end">
      <h2 className="max-w-3xl text-4xl font-black leading-[.95] tracking-[-.065em] sm:text-6xl">
        {title}
      </h2>
      <p className="max-w-[52ch] text-base leading-relaxed text-ink/60 lg:justify-self-end">
        {copy}
      </p>
    </div>
  );
}

function SignalStat({ number, label, detail }: { number: string; label: string; detail: string }) {
  return (
    <div className="signal-stat p-5 sm:p-6">
      <p className="text-sm font-semibold tabular-nums text-emerald">{number}</p>
      <p className="mt-2 text-sm font-bold">{label}</p>
      <p className="mt-1 text-sm text-ink/50">{detail}</p>
    </div>
  );
}

function FeatureHeading({ title, dark = false }: { title: string; dark?: boolean }) {
  return (
    <h3
      className={cn(
        "max-w-lg text-2xl font-black leading-[1.04] tracking-[-.045em] sm:text-3xl",
        dark ? "text-panel-foreground" : "text-foreground",
      )}
    >
      {title}
    </h3>
  );
}

function FormatRow({
  icon,
  label,
  status,
  active = false,
}: {
  icon: string;
  label: string;
  status: string;
  active?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border p-3 transition ${active ? "border-emerald/40 bg-tint-mint shadow-sm" : "border-line-weak bg-glass-weak"}`}
    >
      <span
        className={`grid size-9 place-items-center rounded-lg text-xs font-black ${active ? "bg-panel text-panel-foreground" : "bg-line-weak text-ink-soft"}`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <strong className="block text-xs">{label}</strong>
        <small className="block truncate text-[10px] font-semibold text-ink/42">{status}</small>
      </span>
    </div>
  );
}

function MiniScore({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-bold">
        <span className="truncate text-white/58">{label}</span>
        <span className="text-white/80">{value}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function Claim({
  label,
  verdict,
  tone,
}: {
  label: string;
  verdict: string;
  tone: "emerald" | "amber" | "slate";
}) {
  const styles = {
    emerald: "bg-tint-mint text-tint-mint-foreground",
    amber: "bg-tint-amber text-tint-amber-foreground",
    slate: "bg-muted text-muted-foreground",
  } as const;
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-line-weak bg-glass-weak px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/8 text-emerald">
          <Check className="size-3" />
        </span>
        <p className="text-xs font-bold leading-5 text-ink/75">{label}</p>
      </div>
      <span className={cn("shrink-0 rounded-full px-2.5 py-1 text-[9px] font-black", styles[tone])}>
        {verdict}
      </span>
    </div>
  );
}

function SourceNode({
  date,
  source,
  state,
}: {
  date: string;
  source: string;
  state: "late" | "middle" | "origin";
}) {
  return (
    <div className={`source-node source-node-${state}`}>
      <span className="source-dot" />
      <div>
        <p className="text-xs text-ink-faint">{date}</p>
        <p className="mt-0.5 text-sm font-semibold text-ink/85">{source}</p>
      </div>
      {state === "origin" && (
        <span className="ml-auto rounded-full bg-panel px-2.5 py-1 text-xs font-semibold text-mint">
          Origin
        </span>
      )}
    </div>
  );
}

function EvidenceColumn({
  tone,
  count,
  label,
  sources,
}: {
  tone: "support" | "conflict" | "open";
  count: string;
  label: string;
  sources: string[];
}) {
  const styles = {
    support: "border-emerald/25 bg-tint-mint text-tint-mint-foreground",
    conflict: "border-tint-rose-foreground/25 bg-tint-rose text-tint-rose-foreground",
    open: "border-tint-amber-foreground/25 bg-tint-amber text-tint-amber-foreground",
  };
  return (
    <div className={`rounded-2xl border p-4 ${styles[tone]}`}>
      <div className="flex items-end justify-between">
        <span className="text-sm font-semibold">{label}</span>
        <strong className="text-2xl tabular-nums tracking-[-.06em]">{count}</strong>
      </div>
      <div className="mt-5 space-y-2">
        {sources.map((source) => (
          <p key={source} className="rounded-lg bg-glass-weak px-3 py-2 text-[10px] font-bold">
            {source}
          </p>
        ))}
      </div>
    </div>
  );
}

function ProcessStep({
  number,
  title,
  copy,
  label,
  accent,
}: {
  number: string;
  title: string;
  copy: string;
  label: string;
  accent: string;
}) {
  return (
    <li className="process-step landing-view-reveal">
      <span className="process-number">{number}</span>
      <div className="flex-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-2xl font-black tracking-[-.04em]">{title}</h3>
          <span className={cn("rounded-full px-3 py-1 text-xs font-semibold", accent)}>
            {label}
          </span>
        </div>
        <p className="mt-4 max-w-xl text-sm leading-7 text-ink/58">{copy}</p>
      </div>
    </li>
  );
}

function DarkFeature({ icon, title, copy }: { icon: string; title: string; copy: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[.055] p-4">
      <span className="grid size-8 place-items-center rounded-lg bg-mint/12 text-mint">{icon}</span>
      <p className="mt-4 text-sm font-black">{title}</p>
      <p className="mt-1 text-xs leading-5 text-white/48">{copy}</p>
    </div>
  );
}

function TraceEvent({
  date,
  title,
  detail,
  score,
  change,
  active = false,
}: {
  date: string;
  title: string;
  detail: string;
  score: string;
  change: string;
  active?: boolean;
}) {
  return (
    <div className="trace-event">
      <span className={`trace-event-dot ${active ? "trace-event-dot-active" : ""}`} />
      <div className="flex-1">
        <p className={cn("text-xs", active ? "text-mint" : "text-white/40")}>{date}</p>
        <p className="mt-1 text-sm font-semibold text-white/85">{title}</p>
        <p className="mt-1 text-xs text-white/45">{detail}</p>
      </div>
      <div className="text-right">
        <strong className="block text-lg tracking-[-.04em]">{score}</strong>
        <span className={cn("text-xs font-semibold", active ? "text-mint" : "text-white/40")}>
          {change}
        </span>
      </div>
    </div>
  );
}

function CorpusNode({
  title,
  meta,
  className,
}: {
  title: string;
  meta: string;
  className: string;
}) {
  return (
    <div className={`corpus-node ${className}`}>
      <span className="corpus-node-dot" />
      <span>
        <strong>{title}</strong>
        <small>{meta}</small>
      </span>
    </div>
  );
}

function CorpusMetric({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="text-lg font-black tracking-[-.035em] text-emerald">{value}</p>
      <p className="mt-1 text-[10px] font-bold text-ink/45">{label}</p>
    </div>
  );
}

function HubRow({ score, title, status }: { score: string; title: string; status: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-panel text-sm font-black text-mint">
        {score}
      </span>
      <span className="min-w-0">
        <strong className="block truncate text-xs">{title}</strong>
        <small className="text-[10px] font-bold text-ink/42">{status}</small>
      </span>
    </div>
  );
}
