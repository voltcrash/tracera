"use client";

import { useMemo, useState } from "react";
import type {
  ClaimResult,
  EvidenceSource,
  FramingAnalysis,
  TraceraScore,
  Verdict as VerdictName,
} from "@repo/contracts";
import { ArrowLeft, ChevronDown, ExternalLink } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export type { ClaimResult, TraceraScore } from "@repo/contracts";

export type GroundZeroTrace = {
  status: "candidate" | "not_found" | "inconclusive";
  confidence: "low" | "moderate" | "high";
  earliestSource: { title: string; url?: string; publisher?: string } | null;
  signals: string[];
};

type Tone = "strong" | "mixed" | "weak" | "quiet";

const verdicts = {
  supported: {
    label: "Supported",
    tone: "strong",
    gloss: "Sources Tracera can name back this up.",
  },
  mixed: {
    label: "Mixed",
    tone: "mixed",
    gloss: "Part of it holds up, part of it does not.",
  },
  misleading: {
    label: "Misleading",
    tone: "mixed",
    gloss: "The facts are close, the impression they leave is not.",
  },
  contradicted: {
    label: "Contradicted",
    tone: "weak",
    gloss: "The evidence points the other way.",
  },
  unverified: {
    label: "Unverified",
    tone: "quiet",
    gloss: "No evidence either way yet. That is not the same as false.",
  },
} as const satisfies Record<VerdictName, { label: string; tone: Tone; gloss: string }>;

const verdictOrder = Object.keys(verdicts) as VerdictName[];

function verdictOf(verdict: string) {
  return verdicts[verdict as VerdictName] ?? verdicts.unverified;
}

function scoreTone(value: number): Tone {
  return value >= 70 ? "strong" : value >= 45 ? "mixed" : "weak";
}

function labelTone(label: "strong" | "moderate" | "weak"): Tone {
  return label === "strong" ? "strong" : label === "moderate" ? "mixed" : "weak";
}

export function TraceReport({
  statement,
  checkedAt,
  sourceDomain,
  sourceUrl,
  claims,
  score,
  framing,
  groundZero,
  backHref,
  backLabel,
  children,
}: {
  statement?: string;
  checkedAt?: string;
  sourceDomain?: string | null;
  sourceUrl?: string | null;
  claims: ClaimResult[];
  score: TraceraScore;
  framing?: FramingAnalysis | null;
  groundZero?: GroundZeroTrace | null;
  backHref?: string;
  backLabel?: string;
  children?: React.ReactNode;
}) {
  const sections = [
    { id: "claims", label: claims.length === 1 ? "The claim" : "The claims" },
    ...(framing ? [{ id: "framing", label: "How it is told" }] : []),
    ...(groundZero ? [{ id: "origin", label: "Where it starts" }] : []),
  ];

  return (
    <article className="trace">
      <div className="trace-bar">
        <div className="trace-bar-inner">
          {backHref && (
            <Link href={backHref} className="trace-back">
              <ArrowLeft />
              {backLabel ?? "Back"}
            </Link>
          )}
          <p className="trace-bar-score">
            <span data-tone={scoreTone(score.overall)}>{formatScore(score.overall)}</span>
            {readingOf(score.overall)}
          </p>
          <nav className="trace-bar-nav" aria-label="Sections of this trace">
            {sections.map((section) => (
              <a key={section.id} href={`#${section.id}`}>
                {section.label}
              </a>
            ))}
          </nav>
        </div>
      </div>

      <Masthead
        statement={statement}
        checkedAt={checkedAt}
        sourceDomain={sourceDomain}
        sourceUrl={sourceUrl}
        claims={claims}
        score={score}
      />

      <Claims claims={claims} />
      {framing && <Framing framing={framing} />}
      {groundZero && <Origin trace={groundZero} />}
      {children}
    </article>
  );
}

function Masthead({
  statement,
  checkedAt,
  sourceDomain,
  sourceUrl,
  claims,
  score,
}: {
  statement?: string;
  checkedAt?: string;
  sourceDomain?: string | null;
  sourceUrl?: string | null;
  claims: ClaimResult[];
  score: TraceraScore;
}) {
  const dimensions = [
    ["Factual accuracy", score.factualAccuracy],
    ["Corroboration across sources", score.sourceCorroboration],
    ["Neutral language", score.framingManipulation],
    ["Evidence quality", score.evidenceQuality],
    ["Source reputation", score.sourceReputation ?? score.sourceCorroboration],
  ] as const;

  return (
    <header className="trace-masthead">
      {statement && (
        <blockquote className="trace-statement">
          {isUrl(statement) ? <span className="trace-statement-url">{statement}</span> : statement}
        </blockquote>
      )}

      <dl className="trace-meta">
        <div>
          <dt>Claims found</dt>
          <dd>{claims.length}</dd>
        </div>
        {checkedAt && (
          <div>
            <dt>Checked</dt>
            <dd>{formatDate(checkedAt)}</dd>
          </div>
        )}
        <div>
          <dt>Submitted source</dt>
          <dd>
            {sourceUrl && sourceDomain ? (
              <a href={sourceUrl} target="_blank" rel="noreferrer" className="trace-external">
                {sourceDomain}
                <ExternalLink />
              </a>
            ) : (
              (sourceDomain ?? "Pasted text")
            )}
          </dd>
        </div>
        <div>
          <dt>Newest evidence</dt>
          <dd>
            {score.recency.newestEvidenceAt
              ? formatDate(score.recency.newestEvidenceAt)
              : sentenceCase(score.recency.flag)}
          </dd>
        </div>
      </dl>

      <div className="trace-score" id="score">
        <div className="trace-score-head">
          <p className="trace-score-number" data-tone={scoreTone(score.overall)}>
            {formatScore(score.overall)}
            <span>/100</span>
          </p>
          <div>
            <h2 className="trace-score-reading">{readingOf(score.overall)}</h2>
            <p className="trace-score-say">{sentenceOf(score.overall)}</p>
            <p className="trace-score-caveat">
              The score describes what Tracera found. It is not a ruling on whether the story is
              true.
            </p>
          </div>
        </div>

        <ul className="trace-score-parts">
          {dimensions.map(([name, dimension]) => (
            <li key={name}>
              <span className="trace-score-part-label">{name}</span>
              <span className="trace-score-part-value">{Math.round(dimension.score)}</span>
              <span className="score-rule" data-tone={labelTone(dimension.label)}>
                <span style={{ width: `${Math.max(2, Math.min(100, dimension.score))}%` }} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </header>
  );
}

function Claims({ claims }: { claims: ClaimResult[] }) {
  const [filter, setFilter] = useState<VerdictName | null>(null);
  const counts = useMemo(
    () =>
      verdictOrder
        .map(
          (verdict) => [verdict, claims.filter((item) => item.verdict === verdict).length] as const,
        )
        .filter(([, count]) => count > 0),
    [claims],
  );
  const visible = filter ? claims.filter((item) => item.verdict === filter) : claims;

  return (
    <section className="trace-section" id="claims">
      <div className="trace-section-head">
        <h2 className="trace-section-title">
          {claims.length === 1 ? "One claim to check" : `${claims.length} claims to check`}
        </h2>
        <p className="trace-section-say">
          Tracera splits the story into claims that can be checked on their own, then judges each
          one separately.
        </p>
        {counts.length > 1 && (
          <div className="trace-filters">
            {counts.map(([verdict, count]) => (
              <button
                key={verdict}
                type="button"
                data-tone={verdicts[verdict].tone}
                aria-pressed={filter === verdict}
                onClick={() => setFilter((current) => (current === verdict ? null : verdict))}
              >
                {count} {verdicts[verdict].label.toLowerCase()}
              </button>
            ))}
            {filter && (
              <button type="button" className="trace-filter-clear" onClick={() => setFilter(null)}>
                Show every claim
              </button>
            )}
          </div>
        )}
      </div>

      <ol className="trace-claims">
        {visible.map((item, index) => (
          <Claim
            key={item.claim.id || index}
            item={item}
            index={claims.indexOf(item) + 1}
            single={claims.length === 1}
          />
        ))}
      </ol>
    </section>
  );
}

function Claim({ item, index, single }: { item: ClaimResult; index: number; single: boolean }) {
  const [openSources, setOpenSources] = useState(false);
  const verdict = verdictOf(item.verdict);
  const confidence = Math.round(item.confidence * 100);
  const evidence =
    typeof item.evidenceQuality === "number" ? Math.round(item.evidenceQuality * 100) : null;
  const sources = collectSources(item);
  const context = item.claim.context?.trim();

  return (
    <li className="trace-row" data-tone={verdict.tone}>
      <div className="trace-margin">
        {!single && <span className="trace-margin-number">{index}</span>}
        <span className="trace-margin-verdict">{verdict.label}</span>
        <span className="trace-margin-gloss">{verdict.gloss}</span>
        {item.sourceConflict && <span className="trace-margin-flag">Sources disagree</span>}
      </div>

      <div className="trace-body">
        <h3 className="trace-claim-text">{item.claim.claimText}</h3>
        {context && context !== item.claim.claimText && (
          <p className="trace-claim-context">{context}</p>
        )}

        <ul className="trace-measures">
          <Measure
            label="Verdict confidence"
            value={`${confidence}%`}
            fill={confidence}
            tone={scoreTone(confidence)}
          />
          <Measure
            label="Evidence quality"
            value={evidence === null ? "Not rated" : `${evidence}%`}
            fill={evidence}
            tone={evidence === null ? "quiet" : scoreTone(evidence)}
          />
          <Measure
            label="Checkability"
            value={sentenceCase(item.claim.checkability.replaceAll("_", " "))}
            fill={checkabilityFill(item.claim.checkability)}
            tone={checkabilityFill(item.claim.checkability) >= 100 ? "strong" : "mixed"}
          />
        </ul>

        {item.reasoning.length > 0 && (
          <div className="trace-reasoning">
            <h4>Why this verdict</h4>
            <ul>
              {item.reasoning.map((reason, reasonIndex) => (
                <li key={reasonIndex}>{reason}</li>
              ))}
            </ul>
          </div>
        )}

        {sources.length > 0 && (
          <div className="trace-sources">
            <button
              type="button"
              className="trace-disclose"
              aria-expanded={openSources}
              onClick={() => setOpenSources((open) => !open)}
            >
              {sources.length} {sources.length === 1 ? "source" : "sources"} reviewed
              <ChevronDown className={cn(openSources && "rotate-180")} />
            </button>
            {openSources && (
              <ul className="trace-source-list">
                {sources.map((source) => (
                  <SourceRow key={`${source.stance}-${source.id}`} source={source} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function Measure({
  label,
  value,
  fill,
  tone,
}: {
  label: string;
  value: string;
  fill: number | null;
  tone: Tone;
}) {
  return (
    <li>
      <span className="trace-measure-label">{label}</span>
      <span className="trace-measure-value">{value}</span>
      <span className="score-rule" data-tone={tone}>
        <span style={{ width: `${fill === null ? 0 : Math.max(2, Math.min(100, fill))}%` }} />
      </span>
    </li>
  );
}

type StancedSource = EvidenceSource & { stance: "Supports" | "Conflicts" | "Reviewed" };

function SourceRow({ source }: { source: StancedSource }) {
  const credibility =
    typeof source.credibility === "number" ? Math.round(source.credibility * 100) : null;
  const published = source.publishedAt ? formatDate(source.publishedAt) : null;
  const title = source.url ? (
    <a href={source.url} target="_blank" rel="noreferrer" className="trace-external">
      {source.title}
      <ExternalLink />
    </a>
  ) : (
    source.title
  );

  return (
    <li>
      <span
        className="trace-source-stance"
        data-tone={
          source.stance === "Supports" ? "strong" : source.stance === "Conflicts" ? "weak" : "quiet"
        }
      >
        {source.stance}
      </span>
      <span className="trace-source-title">{title}</span>
      <span className="trace-source-meta">
        {[source.publisher ?? source.sourceDomain, published, source.rating]
          .filter(Boolean)
          .join(", ")}
        {credibility !== null && (
          <span className="trace-source-credibility">{credibility}% credibility</span>
        )}
      </span>
    </li>
  );
}

function Framing({ framing }: { framing: FramingAnalysis }) {
  const integrity = Math.round(framing.integrityScore * 100);
  const risks = [
    { label: "Emotional language", level: framing.emotionalLanguageLevel },
    { label: "Slanted facts", level: framing.factualSkewLevel },
    { label: "Missing context", level: framing.contextOmissionRisk },
  ];

  return (
    <section className="trace-section" id="framing">
      <div className="trace-row">
        <div className="trace-margin">
          <span className="trace-margin-verdict" data-tone={scoreTone(integrity)}>
            {integrity}% plain
          </span>
          <span className="trace-margin-gloss">
            How much the wording lets the facts speak for themselves.
          </span>
        </div>
        <div className="trace-body">
          <h2 className="trace-section-title">How it is told</h2>
          <p className="trace-section-say">
            Presentation is scored apart from truth. A true story can still be written to push you
            towards one reading.
          </p>

          <ul className="trace-measures">
            {risks.map((risk) => (
              <Measure
                key={risk.label}
                label={risk.label}
                value={riskWord(risk.level)}
                fill={Math.round(risk.level * 100)}
                tone={risk.level >= 0.6 ? "weak" : risk.level >= 0.3 ? "mixed" : "strong"}
              />
            ))}
          </ul>

          {framing.findings.length > 0 && (
            <div className="trace-reasoning">
              <h4>What Tracera noticed</h4>
              <ul>
                {framing.findings.map((finding, index) => (
                  <li key={index}>{finding}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Origin({ trace }: { trace: GroundZeroTrace }) {
  const source = trace.earliestSource;

  return (
    <section className="trace-section" id="origin">
      <div className="trace-row">
        <div className="trace-margin">
          <span className="trace-margin-verdict" data-tone={confidenceTone(trace.confidence)}>
            {sentenceCase(`${trace.confidence} confidence`)}
          </span>
          <span className="trace-margin-gloss">How sure Tracera is that nothing older exists.</span>
        </div>
        <div className="trace-body">
          <h2 className="trace-section-title">
            {source ? "Where the trail starts" : "The trail runs cold"}
          </h2>
          <p className="trace-section-say">
            {source
              ? "Tracera followed citations, publication times, and source references back as far as it could."
              : "The evidence in hand does not establish a first source for this story."}
          </p>

          <ol className="trace-trail">
            {trace.signals.slice(0, 3).map((signal, index) => (
              <li key={`${signal}-${index}`}>{signal}</li>
            ))}
            <li className="trace-trail-origin">
              {source ? (
                <>
                  <p className="trace-trail-title">
                    {source.url ? (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="trace-external"
                      >
                        {source.title}
                        <ExternalLink />
                      </a>
                    ) : (
                      source.title
                    )}
                  </p>
                  <p className="trace-trail-meta">
                    {source.publisher ?? "Publisher unknown"}
                    <span className="trace-trail-mark">Earliest found</span>
                  </p>
                </>
              ) : (
                <p className="trace-trail-title">No dependable first source found</p>
              )}
            </li>
          </ol>
        </div>
      </div>
    </section>
  );
}

/** A trace section that borrows the report's margin, for callers adding their own material. */
export function TraceAside({
  id,
  margin,
  gloss,
  children,
}: {
  id?: string;
  margin: string;
  gloss?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="trace-section" id={id}>
      <div className="trace-row">
        <div className="trace-margin">
          <span className="trace-margin-verdict">{margin}</span>
          {gloss && <span className="trace-margin-gloss">{gloss}</span>}
        </div>
        <div className="trace-body">{children}</div>
      </div>
    </section>
  );
}

function readingOf(overall: number) {
  return overall >= 70 ? "Holds up" : overall >= 45 ? "Needs context" : "Thin evidence";
}

function sentenceOf(overall: number) {
  if (overall >= 70) return "Most of this matches sources Tracera can name and date.";
  if (overall >= 45)
    return "Parts of this are checkable, but the evidence behind them is still thin.";
  return "Little of this could be matched to a source Tracera trusts.";
}

function confidenceTone(confidence: "low" | "moderate" | "high"): Tone {
  return confidence === "high" ? "strong" : confidence === "moderate" ? "mixed" : "quiet";
}

function sentenceCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function riskWord(level: number) {
  return level >= 0.6 ? "High" : level >= 0.3 ? "Moderate" : "Low";
}

function checkabilityFill(checkability: string) {
  return checkability === "checkable" ? 100 : checkability === "needs_context" ? 60 : 30;
}

function formatScore(overall: number) {
  return Number.isInteger(overall) ? String(overall) : overall.toFixed(1);
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function isUrl(value: string) {
  return /^https?:\/\/\S+$/.test(value.trim());
}

/** One ranked list beats three columns: stance is a label, not a layout. */
function collectSources(item: ClaimResult): StancedSource[] {
  const seen = new Set<string>();
  const ordered: StancedSource[] = [];
  const groups = [
    { stance: "Supports" as const, sources: item.supportingSources ?? [] },
    { stance: "Conflicts" as const, sources: item.contradictingSources ?? [] },
    { stance: "Reviewed" as const, sources: item.consideredSources ?? [] },
  ];
  for (const group of groups) {
    const ranked = [...group.sources].sort(
      (first, second) => (second.credibility ?? 0) - (first.credibility ?? 0),
    );
    for (const source of ranked) {
      if (seen.has(source.id)) continue;
      seen.add(source.id);
      ordered.push({ ...source, stance: group.stance });
    }
  }
  return ordered;
}
