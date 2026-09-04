"use client";

import { useEffect, useState } from "react";

const signals = [
  {
    id: "corroboration",
    label: "Corroboration",
    score: 82,
    detail: "4 independent reports match the primary record.",
    color: "#9cf0d1",
    points: "68,142 172,78 282,114 392,54",
  },
  {
    id: "source",
    label: "Source trail",
    score: 68,
    detail: "The earliest source is identified, with two later rewrites.",
    color: "#fcd34d",
    points: "68,142 172,114 282,72 392,88",
  },
  {
    id: "language",
    label: "Language",
    score: 44,
    detail: "The headline uses a stronger conclusion than the evidence supports.",
    color: "#fda4af",
    points: "68,142 172,148 282,122 392,160",
  },
];

export function LandingEvidenceGraph() {
  const [activeId, setActiveId] = useState(signals[0]!.id);
  const active = signals.find((signal) => signal.id === activeId) ?? signals[0]!;

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const interval = window.setInterval(() => {
      setActiveId((current) => {
        const currentIndex = signals.findIndex((signal) => signal.id === current);
        return signals[(currentIndex + 1) % signals.length]!.id;
      });
    }, 4200);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <section
      className="noise relative overflow-hidden rounded-[2rem] bg-panel p-6 text-panel-foreground shadow-(--shadow-panel) sm:p-8"
      aria-label="Interactive evidence map"
    >
      <div className="evidence-glow" aria-hidden="true" />
      <div className="relative z-10 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black leading-tight tracking-[-.045em]">
            One story.
            <br />
            More than one signal.
          </h2>
        </div>
        <span className="mt-1 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white/70">
          <span className="landing-status-dot" /> Live trace
        </span>
      </div>
      <div className="relative z-10 mt-6">
        <svg
          viewBox="0 0 460 205"
          className="h-auto w-full"
          role="img"
          aria-label={`${active.label} evidence path, score ${active.score} out of 100`}
        >
          <defs>
            <linearGradient id="signal-fade" x1="0" x2="1">
              <stop stopColor={active.color} stopOpacity=".2" />
              <stop offset="1" stopColor={active.color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[46, 92, 138, 184].map((y) => (
            <line
              key={y}
              x1="42"
              x2="418"
              y1={y}
              y2={y}
              stroke="white"
              strokeOpacity=".1"
              strokeDasharray="3 5"
            />
          ))}
          {signals.map((signal) => (
            <polyline
              key={signal.id}
              points={signal.points}
              fill="none"
              stroke={signal.id === active.id ? signal.color : "white"}
              strokeOpacity={signal.id === active.id ? 1 : 0.18}
              strokeWidth={signal.id === active.id ? 4 : 2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={
                signal.id === active.id
                  ? "evidence-path-active transition-all duration-500"
                  : "transition-all duration-500"
              }
            />
          ))}
          <path
            d={`M ${active.points
              .split(" ")
              .map((point) => point.replace(",", " "))
              .join(" L ")} L 392 190 L 68 190 Z`}
            fill="url(#signal-fade)"
            opacity=".4"
          />
          {[
            { x: 68, label: "Origin" },
            { x: 172, label: "Reports" },
            { x: 282, label: "Records" },
            { x: 392, label: "Verdict" },
          ].map(({ x, label }) => (
            <g key={label}>
              <line x1={x} x2={x} y1="26" y2="184" stroke="white" strokeOpacity=".1" />
              <text
                x={x}
                y="201"
                textAnchor="middle"
                fill="white"
                fillOpacity=".45"
                fontSize="10"
                fontWeight="700"
              >
                {label}
              </text>
            </g>
          ))}
          {active.points.split(" ").map((point, index) => {
            const [cx, cy] = point.split(",");
            return (
              <circle
                key={`${active.id}-${point}`}
                cx={cx}
                cy={cy}
                r="5"
                fill={active.color}
                stroke="#063d32"
                strokeWidth="3"
                className="evidence-point"
                style={{ animationDelay: `${index * 90}ms` }}
              />
            );
          })}
        </svg>
      </div>
      <div className="relative z-10 mt-4 flex flex-wrap gap-x-4 gap-y-2">
        {signals.map((signal) => (
          <button
            key={signal.id}
            type="button"
            onClick={() => setActiveId(signal.id)}
            aria-pressed={signal.id === active.id}
            className={`inline-flex items-center gap-2 text-xs font-bold transition ${signal.id === active.id ? "text-white" : "text-white/45 hover:text-white/75"}`}
          >
            <span className="size-2 rounded-full" style={{ backgroundColor: signal.color }} />
            {signal.label}
          </button>
        ))}
      </div>
      <div className="relative z-10 mt-5 flex items-end justify-between gap-4 border-t border-white/10 pt-4">
        <p className="max-w-[17rem] text-xs leading-5 text-white/65">{active.detail}</p>
        <p className="shrink-0 text-right">
          <span
            className="block text-2xl font-black tracking-[-.07em]"
            style={{ color: active.color }}
          >
            {active.score}
          </span>
          <span className="text-xs text-white/45">signal</span>
        </p>
      </div>
    </section>
  );
}
