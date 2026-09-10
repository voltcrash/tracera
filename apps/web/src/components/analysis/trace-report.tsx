"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  ClaimResult,
  EvidenceSource,
  FramingAnalysis,
  TraceraScore,
  Verdict as VerdictName,
} from "@repo/contracts";
import { ChevronDown, ExternalLink } from "lucide-react";
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
  headline,
  statement,
  checkedAt,
  sourceDomain,
  sourceUrl,
  claims,
  score,
  framing,
  groundZero,
  children,
}: {
  headline?: string;
  statement?: string;
  checkedAt?: string;
  sourceDomain?: string | null;
  sourceUrl?: string | null;
  claims: ClaimResult[];
  score: TraceraScore;
  framing?: FramingAnalysis | null;
  groundZero?: GroundZeroTrace | null;
  children?: React.ReactNode;
}) {
  const sources = useMemo(
    () => collectSources(claims, { headline, sourceUrl, sourceDomain }),
    [claims, headline, sourceDomain, sourceUrl],
  );
  const sections = [
    { id: "verdict", label: "Verdict" },
    { id: "claims", label: claims.length === 1 ? "Claim" : "Claims" },
    ...(sources.length > 0 ? [{ id: "sources", label: "Sources" }] : []),
    ...(framing ? [{ id: "framing", label: "Wording" }] : []),
    ...(groundZero ? [{ id: "origin", label: "Origin" }] : []),
  ];
  const active = useActiveSection(sections.map((section) => section.id));

  return (
    <article className="trace">
      <Verdict
        headline={headline}
        statement={statement}
        checkedAt={checkedAt}
        claims={claims}
        score={score}
        sections={sections}
        active={active}
      />

      <Claims claims={claims} />
      {sources.length > 0 && <Sources sources={sources} />}
      {framing && <Framing framing={framing} />}
      {groundZero && <Origin trace={groundZero} />}
      {children}
    </article>
  );
}

/** Marks the section the reader is in so the bar says where they are. */
function useActiveSection(ids: string[]) {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join("|");

  useEffect(() => {
    const sections = key
      .split("|")
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => Boolean(element));
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((first, second) => first.boundingClientRect.top - second.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: "-20% 0px -65% 0px", threshold: 0 },
    );
    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, [key]);

  return active;
}

function Section({
  id,
  title,
  lede,
  count,
  children,
}: {
  id: string;
  title: string;
  lede: string;
  count?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="trace-section" id={id}>
      <header className="trace-section-head">
        <h2 className="trace-section-title">{title}</h2>
        {count && <p className="trace-section-count">{count}</p>}
        <p className="trace-section-lede">{lede}</p>
      </header>
      {children}
    </section>
  );
}

function Verdict({
  headline,
  statement,
  checkedAt,
  claims,
  score,
  sections,
  active,
}: {
  headline?: string;
  statement?: string;
  checkedAt?: string;
  claims: ClaimResult[];
  score: TraceraScore;
  sections: { id: string; label: string }[];
  active: string | null;
}) {
  const dimensions = [
    ["Factual accuracy", score.factualAccuracy],
    ["Corroboration", score.sourceCorroboration],
    ["Evidence quality", score.evidenceQuality],
    ["Source reputation", score.sourceReputation ?? score.sourceCorroboration],
    ["Neutral language", score.framingManipulation],
  ] as const;
  const overall = Math.max(0, Math.min(100, score.overall));
  const title = headline ?? (statement && !isUrl(statement) ? statement : undefined);

  return (
    <header className="trace-verdict" id="verdict">
      <div className="trace-masthead">
        {title && <h1 className="trace-headline">{title}</h1>}
        <nav className="trace-nav" aria-label="Sections of this trace">
          {sections.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              aria-current={active === section.id ? "true" : undefined}
            >
              {section.label}
            </a>
          ))}
        </nav>
      </div>

      <div className="trace-dial-row" data-tone={scoreTone(score.overall)}>
        <div
          className="trace-dial"
          style={{ "--fill": `${overall * 3.6}deg` } as React.CSSProperties}
          role="img"
          aria-label={`Tracera score ${formatScore(score.overall)} out of 100`}
        >
          <span className="trace-dial-number">{formatScore(score.overall)}</span>
          <span className="trace-dial-scale">/100</span>
        </div>
        <div className="trace-dial-say">
          <p className="trace-reading">{readingOf(score.overall)}</p>
          <p className="trace-reading-say">{sentenceOf(score.overall)}</p>
          <p className="trace-reading-caveat">
            The score describes what Tracera found. It is not a ruling on whether the story is true.
          </p>
        </div>

        <dl className="trace-facts">
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
            <dt>Newest evidence</dt>
            <dd>
              {score.recency.newestEvidenceAt
                ? formatDate(score.recency.newestEvidenceAt)
                : sentenceCase(score.recency.flag)}
            </dd>
          </div>
        </dl>
      </div>

      <ul className="trace-dimensions">
        {dimensions.map(([name, dimension]) => (
          <li key={name}>
            <span className="trace-dimension-label">{name}</span>
            <span className="trace-dimension-value">{Math.round(dimension.score)}</span>
            <span className="score-rule" data-tone={labelTone(dimension.label)}>
              <span style={{ width: `${Math.max(2, Math.min(100, dimension.score))}%` }} />
            </span>
          </li>
        ))}
      </ul>
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
    <Section
      id="claims"
      title={claims.length === 1 ? "The claim" : "The claims"}
      count={`${claims.length} checked`}
      lede="Tracera splits the story into claims that can be checked on their own, then judges each one separately."
    >
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

      <ol className="trace-claims">
        {visible.map((item, index) => (
          <Claim key={item.claim.id || index} item={item} />
        ))}
      </ol>
    </Section>
  );
}

function Claim({ item }: { item: ClaimResult }) {
  const [openSources, setOpenSources] = useState(false);
  const verdict = verdictOf(item.verdict);
  const confidence = Math.round(item.confidence * 100);
  const evidence =
    typeof item.evidenceQuality === "number" ? Math.round(item.evidenceQuality * 100) : null;
  const sources = claimSources(item);
  const context = item.claim.context?.trim();

  return (
    <li className="trace-claim" data-tone={verdict.tone}>
      <div className="trace-claim-head">
        <span className="trace-claim-verdict">{verdict.label}</span>
        <p className="trace-claim-gloss">{verdict.gloss}</p>
        {item.claim.checkability !== "checkable" && (
          <span className="trace-claim-flag" data-flag="checkability">
            {checkabilityWord(item.claim.checkability)}
          </span>
        )}
        {item.sourceConflict && <span className="trace-claim-flag">Sources disagree</span>}
      </div>

      <div className="trace-claim-body">
        <div className="trace-claim-said">
          <h3 className="trace-claim-text">{item.claim.claimText}</h3>
          {context && context !== item.claim.claimText && (
            <p className="trace-claim-context">{context}</p>
          )}

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
        </div>

        <ul className="trace-stats">
          <Stat label="Confidence" value={`${confidence}%`} />
          <Stat label="Evidence quality" value={evidence === null ? "Not rated" : `${evidence}%`} />
          <Stat
            label={sources.length === 1 ? "Source" : "Sources"}
            value={String(sources.length)}
          />
        </ul>
      </div>

      {sources.length > 0 && (
        <div className="trace-claim-sources">
          <button
            type="button"
            className="trace-disclose"
            aria-expanded={openSources}
            onClick={() => setOpenSources((open) => !open)}
          >
            {openSources ? "Hide the" : "Read the"} {sources.length}{" "}
            {sources.length === 1 ? "source" : "sources"} behind this claim
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
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <li>
      <span className="trace-stat-value">{value}</span>
      <span className="trace-stat-label">{label}</span>
    </li>
  );
}

type StancedSource = EvidenceSource & {
  stance: "Submitted" | "Supports" | "Conflicts" | "Reviewed";
};

const stanceTones: Record<StancedSource["stance"], Tone> = {
  Submitted: "mixed",
  Supports: "strong",
  Conflicts: "weak",
  Reviewed: "quiet",
};

function Sources({ sources }: { sources: StancedSource[] }) {
  const domains = new Set(
    sources
      .map((source) => source.sourceDomain ?? source.publisher)
      .filter((domain): domain is string => Boolean(domain)),
  );

  return (
    <Section
      id="sources"
      title="The sources"
      count={`${sources.length} ${sources.length === 1 ? "source" : "sources"}, ${domains.size} ${domains.size === 1 ? "publisher" : "publishers"}`}
      lede="Every source Tracera weighed, starting with the one you submitted. A source being read does not mean it was believed."
    >
      <ul className="trace-source-list trace-source-list-full">
        {sources.map((source) => (
          <SourceRow key={`${source.stance}-${source.id}`} source={source} />
        ))}
      </ul>
    </Section>
  );
}

function SourceRow({ source }: { source: StancedSource }) {
  const credibility =
    typeof source.credibility === "number" ? Math.round(source.credibility * 100) : null;
  const published = source.publishedAt ? formatDate(source.publishedAt) : null;

  return (
    <li>
      <span className="trace-source-stance" data-tone={stanceTones[source.stance]}>
        {source.stance}
      </span>
      <span className="trace-source-title">
        {source.url ? (
          <a href={source.url} target="_blank" rel="noreferrer" className="trace-external">
            {source.title}
            <ExternalLink />
          </a>
        ) : (
          source.title
        )}
      </span>
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
    <Section
      id="framing"
      title="How it is told"
      count={`${integrity}% plain wording`}
      lede="Presentation is scored apart from truth. A true story can still be written to push you towards one reading."
    >
      <ul className="trace-gauges">
        {risks.map((risk) => (
          <li
            key={risk.label}
            data-tone={risk.level >= 0.6 ? "weak" : risk.level >= 0.3 ? "mixed" : "strong"}
          >
            <span className="trace-gauge-value">{riskWord(risk.level)}</span>
            <span className="trace-gauge-label">{risk.label}</span>
            <span className="trace-gauge-track">
              <span style={{ width: `${Math.max(3, Math.round(risk.level * 100))}%` }} />
            </span>
          </li>
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
    </Section>
  );
}

function Origin({ trace }: { trace: GroundZeroTrace }) {
  const source = trace.earliestSource;

  return (
    <Section
      id="origin"
      title={source ? "Where the trail starts" : "The trail runs cold"}
      count={`${sentenceCase(trace.confidence)} confidence`}
      lede={
        source
          ? "Tracera followed citations, publication times, and source references back as far as it could."
          : "The evidence in hand does not establish a first source for this story."
      }
    >
      <ol className="trace-trail">
        {trace.signals.slice(0, 3).map((signal, index) => (
          <li key={`${signal}-${index}`}>{signal}</li>
        ))}
        <li className="trace-trail-origin">
          {source ? (
            <>
              <p className="trace-trail-title">
                {source.url ? (
                  <a href={source.url} target="_blank" rel="noreferrer" className="trace-external">
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
    </Section>
  );
}

/** A trace section that matches the report's chrome, for callers adding their own material. */
export function TraceAside({
  id,
  title,
  count,
  lede,
  children,
}: {
  id?: string;
  title: string;
  count?: string;
  lede: string;
  children?: React.ReactNode;
}) {
  return (
    <Section id={id ?? "aside"} title={title} count={count} lede={lede}>
      {children}
    </Section>
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

function sentenceCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function checkabilityWord(checkability: ClaimResult["claim"]["checkability"]) {
  return checkability === "needs_context" ? "Needs context to check" : "Cannot be checked";
}

function riskWord(level: number) {
  return level >= 0.6 ? "High" : level >= 0.3 ? "Moderate" : "Low";
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
function claimSources(item: ClaimResult): StancedSource[] {
  return rank([
    { stance: "Supports" as const, sources: item.supportingSources ?? [] },
    { stance: "Conflicts" as const, sources: item.contradictingSources ?? [] },
    { stance: "Reviewed" as const, sources: item.consideredSources ?? [] },
  ]);
}

/** The whole report's evidence in one list, led by what the reader handed in. */
function collectSources(
  claims: ClaimResult[],
  submitted: { headline?: string; sourceUrl?: string | null; sourceDomain?: string | null },
): StancedSource[] {
  const submittedSource: StancedSource[] = submitted.sourceUrl
    ? [
        {
          id: "submitted",
          type: "submitted_source",
          title: submitted.headline ?? submitted.sourceDomain ?? submitted.sourceUrl,
          publisher: submitted.sourceDomain ?? undefined,
          url: submitted.sourceUrl,
          sourceDomain: submitted.sourceDomain,
          stance: "Submitted",
        },
      ]
    : [];
  const seen = new Set(
    submittedSource.flatMap((source) =>
      [source.url, source.canonicalUrl].filter((url): url is string => Boolean(url)),
    ),
  );
  const rest = rank([
    {
      stance: "Supports" as const,
      sources: claims.flatMap((item) => item.supportingSources ?? []),
    },
    {
      stance: "Conflicts" as const,
      sources: claims.flatMap((item) => item.contradictingSources ?? []),
    },
    {
      stance: "Reviewed" as const,
      sources: claims.flatMap((item) => item.consideredSources ?? []),
    },
  ]).filter((source) => !seen.has(source.canonicalUrl ?? source.url ?? source.id));

  return [...submittedSource, ...rest];
}

function rank(groups: Array<{ stance: StancedSource["stance"]; sources: EvidenceSource[] }>) {
  const seen = new Set<string>();
  const ordered: StancedSource[] = [];
  for (const group of groups) {
    const sorted = [...group.sources].sort(
      (first, second) => (second.credibility ?? 0) - (first.credibility ?? 0),
    );
    for (const source of sorted) {
      const key = source.canonicalUrl ?? source.url ?? source.id;
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push({ ...source, stance: group.stance });
    }
  }
  return ordered;
}
