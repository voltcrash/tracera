import Link from "next/link";
import Image from "next/image";
import { LandingEvidenceGraph } from "./components/landing-evidence-graph";

export default function LandingPage() {
  return (
    <main className="paper-grid min-h-screen bg-[#f4f6f2] text-emerald-950">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <header className="flex items-center justify-between border-b border-emerald-950/10 py-5">
          <Link href="/" className="group block rounded-lg transition hover:-translate-y-0.5" aria-label="Tracera home">
            <Image src="/brand/tracera-wordmark-cropped.png" alt="Tracera" width={148} height={34} priority className="h-8 w-auto" />
          </Link>
          <nav className="flex items-center gap-2" aria-label="Primary navigation">
            <Link href="/hub" className="hidden rounded-full px-3.5 py-2 text-sm font-semibold text-emerald-950/65 transition hover:bg-emerald-950/7 hover:text-emerald-950 sm:block">News Hub</Link>
            <Link href="/login" className="rounded-full px-3.5 py-2 text-sm font-semibold text-emerald-950/65 transition hover:bg-emerald-950/7 hover:text-emerald-950">Log in</Link>
            <Link href="/home" className="rounded-xl bg-emerald-950 px-4 py-2.5 text-sm font-black text-white shadow-[3px_3px_0_#8ee8cb] transition hover:-translate-y-0.5">Start a trace →</Link>
          </nav>
        </header>

        <section className="grid gap-12 py-20 sm:py-28 lg:grid-cols-[1.15fr_.85fr] lg:items-center">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-emerald-950/15 bg-white/80 px-3 py-1.5 text-[10px] font-black tracking-[.16em] text-emerald-900 shadow-sm"><span className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,.15)]" /> EVIDENCE, NOT ECHOES</p>
            <h1 className="mt-7 max-w-3xl text-5xl font-black leading-[.92] tracking-[-.08em] sm:text-7xl">Know what a story says.<span className="block text-emerald-600">And what it leaves out.</span></h1>
            <p className="mt-7 max-w-xl text-lg leading-8 text-emerald-950/65">Tracera traces news back to its sources, breaks it into checkable claims, and makes uncertainty visible.</p>
            <div className="mt-9 flex flex-wrap gap-3"><Link href="/home" className="rounded-xl bg-emerald-950 px-5 py-3.5 text-sm font-black text-white shadow-[4px_4px_0_#8ee8cb] transition hover:-translate-y-0.5">Check a story →</Link><Link href="/hub" className="rounded-xl border border-emerald-950/15 bg-white px-5 py-3.5 text-sm font-black text-emerald-950 transition hover:bg-emerald-50">Explore the News Hub</Link></div>
          </div>
          <LandingEvidenceGraph />
        </section>

        <section className="border-t border-emerald-950/10 py-20 sm:py-28">
          <div className="max-w-2xl"><p className="text-[10px] font-black tracking-[.2em] text-emerald-700">BUILT FOR THE FULL PICTURE</p><h2 className="mt-4 text-4xl font-black leading-[.95] tracking-[-.065em] sm:text-5xl">A verdict is only useful when you can see why.</h2><p className="mt-5 text-lg leading-8 text-emerald-950/60">Tracera keeps the source, claims, evidence, and changes in one traceable place.</p></div>

          <div className="mt-12 grid gap-5 lg:grid-cols-[1.2fr_.8fr]">
            <article className="overflow-hidden rounded-[2rem] border border-emerald-950/10 bg-white shadow-[0_28px_70px_-48px_rgba(16,34,31,.55)]">
              <div className="flex items-center justify-between border-b border-emerald-950/10 px-6 py-5"><div><p className="text-[10px] font-black tracking-[.17em] text-emerald-700">CLAIM DECOMPOSITION</p><h3 className="mt-1 text-xl font-black tracking-[-.035em]">See which parts hold up.</h3></div><span className="grid size-9 place-items-center rounded-xl bg-emerald-50 text-lg text-emerald-800">⌁</span></div>
              <div className="p-4 sm:p-6"><p className="rounded-xl bg-[#f5f8f4] px-4 py-3 text-sm font-semibold leading-6 text-emerald-950/70">“The new policy will lower bills for every household this year.”</p><div className="mt-4 space-y-3"><Claim label="The policy was announced this week" verdict="Supported" tone="emerald" /><Claim label="It lowers bills for every household" verdict="Needs context" tone="amber" /><Claim label="The savings begin this year" verdict="Unverified" tone="slate" /></div></div>
              <div className="flex items-center justify-between border-t border-emerald-950/10 bg-emerald-950/[.025] px-6 py-4 text-sm"><span className="font-semibold text-emerald-950/55">3 claims identified</span><Link href="/home" className="font-black text-emerald-800 hover:text-emerald-600">Start a trace →</Link></div>
            </article>
            <article className="rounded-[2rem] bg-emerald-950 p-6 text-white shadow-[0_28px_70px_-48px_rgba(16,34,31,.75)] sm:p-7"><p className="text-[10px] font-black tracking-[.17em] text-[#9cf0d1]">THE TRACERA SCORE</p><h3 className="mt-3 text-2xl font-black leading-tight tracking-[-.045em]">Confidence without the black box.</h3><div className="mt-8 space-y-5"><ScoreRow label="Cross-source corroboration" value={82} color="bg-[#9cf0d1]" /><ScoreRow label="Evidence quality" value={71} color="bg-emerald-400" /><ScoreRow label="Source reputation" value={89} color="bg-teal-300" /><ScoreRow label="Emotional language" value={38} color="bg-amber-300" /></div><p className="mt-8 border-t border-white/10 pt-4 text-sm leading-6 text-white/60">Each signal stays separate, so a strong source can’t hide weak evidence.</p></article>
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-[.78fr_1.22fr]">
            <article className="rounded-[2rem] border border-emerald-950/10 bg-[#dff7ed] p-6 sm:p-7"><p className="text-[10px] font-black tracking-[.17em] text-emerald-700">GROUND ZERO</p><h3 className="mt-3 max-w-sm text-3xl font-black leading-[.98] tracking-[-.055em]">Find where the story first appeared.</h3><p className="mt-5 max-w-sm text-sm leading-6 text-emerald-950/65">Trace the reporting trail back through rewrites, citations, and the earliest known source.</p><div className="mt-7 flex items-center gap-2 text-xs font-black text-emerald-900"><span className="grid size-7 place-items-center rounded-full bg-emerald-950 text-[#9cf0d1]">01</span><span className="h-px flex-1 bg-emerald-900/20" /><span className="grid size-7 place-items-center rounded-full border border-emerald-900/20 bg-white">02</span><span className="h-px flex-1 bg-emerald-900/20" /><span className="grid size-7 place-items-center rounded-full border border-emerald-900/20 bg-white">03</span></div></article>
            <article className="rounded-[2rem] border border-emerald-950/10 bg-white p-6 shadow-[0_28px_70px_-48px_rgba(16,34,31,.55)] sm:p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-[10px] font-black tracking-[.17em] text-emerald-700">NEWS HUB</p><h3 className="mt-2 text-2xl font-black tracking-[-.045em]">Stories continue after the first check.</h3></div><Link href="/hub" className="text-sm font-black text-emerald-800 hover:text-emerald-600">Open Hub →</Link></div><div className="mt-7 grid gap-4 sm:grid-cols-[1fr_auto]"><div className="relative border-l-2 border-emerald-100 pl-5"><Timeline date="Today" title="New evidence added" text="Two independent reports reinforce the primary record." /><Timeline date="3 days ago" title="Score updated" text="Evidence quality rose from 62 to 71." /><Timeline date="Last week" title="First checked" text="The original source and claims were logged." /></div><div className="flex min-w-36 flex-col justify-end rounded-2xl bg-[#f5f8f4] p-4"><span className="text-[10px] font-black tracking-[.14em] text-emerald-950/45">LIVE TRACE</span><span className="mt-2 text-3xl font-black tracking-[-.07em] text-emerald-800">+09</span><span className="text-xs font-bold text-emerald-950/55">points this week</span></div></div></article>
          </div>
        </section>
      </div>
    </main>
  );
}

function Claim({ label, verdict, tone }: { label: string; verdict: string; tone: "emerald" | "amber" | "slate" }) {
  const styles = { emerald: "bg-emerald-100 text-emerald-800", amber: "bg-amber-100 text-amber-800", slate: "bg-slate-100 text-slate-700" };
  return <div className="flex items-center justify-between gap-4 rounded-xl border border-emerald-950/8 px-4 py-3"><p className="text-sm font-semibold text-emerald-950/75">{label}</p><span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-black ${styles[tone]}`}>{verdict}</span></div>;
}

function ScoreRow({ label, value, color }: { label: string; value: number; color: string }) {
  return <div><div className="mb-2 flex items-center justify-between gap-3 text-xs font-bold"><span className="text-white/75">{label}</span><span className="text-white">{value}</span></div><div className="h-2 overflow-hidden rounded-full bg-white/12"><div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} /></div></div>;
}

function Timeline({ date, title, text }: { date: string; title: string; text: string }) {
  return <div className="relative pb-5 last:pb-0"><span className="absolute -left-[1.69rem] top-1 size-2.5 rounded-full border-2 border-white bg-emerald-500" /><p className="text-[10px] font-black tracking-[.12em] text-emerald-700">{date}</p><p className="mt-1 text-sm font-black tracking-[-.015em]">{title}</p><p className="mt-1 text-xs leading-5 text-emerald-950/55">{text}</p></div>;
}
