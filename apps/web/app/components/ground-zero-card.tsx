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
      ? "bg-emerald-950 text-[#9cf0d1]"
      : trace.confidence === "moderate"
        ? "bg-amber-100 text-amber-800"
        : "bg-slate-100 text-slate-700";

  return (
    <section className="ground-zero-result mt-5 overflow-hidden rounded-[2rem] border border-emerald-900/15 bg-[#d7f3e8] p-6 shadow-[0_24px_60px_-46px_rgba(16,34,31,.58)] sm:p-8">
      <div className="grid gap-8 lg:grid-cols-[.75fr_1.25fr] lg:items-center">
        <div>
          <p className="text-[10px] font-black tracking-[.18em] text-[#08785d]">
            GROUND ZERO · SOURCE ORIGIN
          </p>
          <h2 className="mt-3 max-w-md text-3xl font-black leading-[.98] tracking-[-.055em] text-emerald-950">
            {trace.earliestSource
              ? "The earliest known trail starts here."
              : "The origin is still unresolved."}
          </h2>
          <p className="mt-4 max-w-md text-sm leading-6 text-[#355e54]">
            {trace.earliestSource
              ? "Tracera followed citations, publication timing, and source references back to this origin candidate."
              : "The available evidence does not establish a reliable first source yet."}
          </p>
          <span
            className={`mt-5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[9px] font-black uppercase tracking-[.1em] ${tone}`}
          >
            <span className="size-1.5 rounded-full bg-current opacity-65" />
            {trace.confidence} confidence
          </span>
        </div>

        <div className="rounded-2xl border border-emerald-950/10 bg-white/85 p-4 sm:p-5">
          <div className="ground-zero-path">
            {trace.signals.slice(0, 3).map((signal, index) => (
              <div key={`${signal}-${index}`} className="ground-zero-step">
                <span className="ground-zero-dot" />
                <div className="min-w-0">
                  <p className="text-[9px] font-black uppercase tracking-[.12em] text-[#37685e]">
                    Signal {String(index + 1).padStart(2, "0")}
                  </p>
                  <p className="mt-1 text-xs font-bold leading-5 text-[#23483f]">{signal}</p>
                </div>
              </div>
            ))}

            <div className="ground-zero-step ground-zero-origin">
              <span className="ground-zero-dot" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[9px] font-black uppercase tracking-[.12em] text-emerald-700">
                    {trace.earliestSource ? "Earliest source" : "Origin status"}
                  </p>
                  <span className="rounded-full bg-emerald-950 px-2 py-1 text-[8px] font-black tracking-[.08em] text-[#9cf0d1]">
                    {trace.earliestSource ? "ORIGIN" : "OPEN"}
                  </span>
                </div>
                {trace.earliestSource ? (
                  trace.earliestSource.url ? (
                    <a
                      className="mt-1.5 block text-sm font-black leading-5 text-emerald-950 transition hover:text-emerald-700"
                      href={trace.earliestSource.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {trace.earliestSource.title} <span aria-hidden="true">↗</span>
                      {trace.earliestSource.publisher && (
                        <small className="mt-1 block text-[10px] font-semibold text-[#42675e]">
                          {trace.earliestSource.publisher}
                        </small>
                      )}
                    </a>
                  ) : (
                    <p className="mt-1.5 text-sm font-black leading-5 text-emerald-950">
                      {trace.earliestSource.title}
                      {trace.earliestSource.publisher && (
                        <small className="mt-1 block text-[10px] font-semibold text-[#42675e]">
                          {trace.earliestSource.publisher}
                        </small>
                      )}
                    </p>
                  )
                ) : (
                  <p className="mt-1.5 text-sm font-black text-emerald-950">
                    No dependable origin candidate found
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
