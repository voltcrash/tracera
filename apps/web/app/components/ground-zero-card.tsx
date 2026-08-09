export type GroundZeroTrace = {
  status: "candidate" | "not_found" | "inconclusive";
  confidence: "low" | "moderate" | "high";
  earliestSource: {
    title: string;
    url?: string;
    publisher?: string;
  } | null;
  signals: string[];
};

export function GroundZeroCard({ trace }: { trace: GroundZeroTrace }) {
  const tone =
    trace.confidence === "high"
      ? "bg-emerald-100 text-emerald-800"
      : trace.confidence === "moderate"
        ? "bg-amber-100 text-amber-800"
        : "bg-slate-100 text-slate-700";

  return (
    <section className="mt-6 rounded-3xl border border-emerald-950/10 bg-white p-6 shadow-[0_8px_30px_-18px_rgba(16,34,31,.3)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black tracking-[.18em] text-emerald-800">
            GROUND ZERO
          </p>
          <h2 className="mt-1 text-xl font-black tracking-tight">
            {trace.earliestSource
              ? "Earliest origin candidate"
              : "Origin not yet established"}
          </h2>
        </div>
        <span
          className={`rounded-full px-3 py-1.5 text-xs font-black capitalize ${tone}`}
        >
          {trace.confidence} confidence
        </span>
      </div>
      {trace.earliestSource && (
        <a
          className="mt-4 block font-bold text-emerald-800 underline decoration-emerald-300 underline-offset-4"
          href={trace.earliestSource.url}
          rel="noreferrer"
          target="_blank"
        >
          {trace.earliestSource.title}
          {trace.earliestSource.publisher
            ? ` · ${trace.earliestSource.publisher}`
            : ""}
        </a>
      )}
      <ul className="mt-4 space-y-2 text-sm leading-6 text-emerald-950/65">
        {trace.signals.map((signal) => (
          <li key={signal} className="flex gap-2">
            <span className="text-emerald-600">•</span>
            {signal}
          </li>
        ))}
      </ul>
    </section>
  );
}
