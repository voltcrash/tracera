import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";

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
    trace.confidence === "high" ? "default" : trace.confidence === "moderate" ? "amber" : "slate";

  return (
    <section className="ground-zero-result mt-8 overflow-hidden rounded-3xl bg-accent px-6 py-8 sm:px-8">
      <div className="grid gap-8 lg:grid-cols-[22rem_minmax(0,1fr)] lg:gap-12">
        <div>
          <h2 className="max-w-md text-3xl font-black leading-[1.02] tracking-[-.045em]">
            {trace.earliestSource
              ? "The earliest known trail starts here"
              : "The origin is still unresolved"}
          </h2>
          <p className="mt-3 max-w-[46ch] text-sm leading-relaxed text-accent-foreground/70">
            {trace.earliestSource
              ? "Tracera followed citations, publication timing, and source references back to this origin candidate."
              : "The available evidence doesn't establish a reliable first source yet."}
          </p>
          <Badge variant={tone} className="mt-5 px-3 py-1.5 capitalize">
            <span className="size-1.5 rounded-full bg-current opacity-65" />
            {trace.confidence} confidence
          </Badge>
        </div>

        <ol className="ground-zero-path">
          {trace.signals.slice(0, 3).map((signal, index) => (
            <li key={`${signal}-${index}`} className="ground-zero-step">
              <span className="ground-zero-dot" />
              <p className="min-w-0 text-sm leading-relaxed text-accent-foreground/80">{signal}</p>
            </li>
          ))}

          <li className="ground-zero-step ground-zero-origin">
            <span className="ground-zero-dot" />
            <div className="min-w-0 flex-1">
              {trace.earliestSource ? (
                <>
                  {trace.earliestSource.url ? (
                    <a
                      className="text-base font-bold leading-snug transition hover:text-brand-emerald"
                      href={trace.earliestSource.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {trace.earliestSource.title}
                      <ExternalLink className="ml-1 inline size-3.5 align-baseline" />
                    </a>
                  ) : (
                    <p className="text-base font-bold leading-snug">{trace.earliestSource.title}</p>
                  )}
                  <p className="mt-1 text-sm text-accent-foreground/60">
                    {trace.earliestSource.publisher ?? "Earliest source"}
                  </p>
                </>
              ) : (
                <p className="text-base font-bold">No dependable origin candidate found</p>
              )}
            </div>
          </li>
        </ol>
      </div>
    </section>
  );
}
