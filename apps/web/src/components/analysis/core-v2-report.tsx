"use client";

import type { CoreV2ReportView } from "@repo/ai/core/report-view";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function CoreV2Report({ view }: { view: CoreV2ReportView }) {
  const { score } = view;
  const counts = score.counts;
  const denominatorLabel = score.selectedClaimCount === null ? "eligible" : "selected";
  const scoreUnavailable = score.value === null;

  return (
    <article className="trace">
      <header className="trace-verdict" id="verdict">
        <div className="trace-masthead">
          <div>
            <Badge variant="violet">Core v2 · {humanize(view.status)}</Badge>
            <h1 className="trace-headline mt-4">Evidence-backed analysis</h1>
            {view.reusedFromRunId ? (
              <p className="mt-2 text-sm text-ink-soft">
                Reused from an identical earlier submission ({view.reusedFromRunId}); evidence is as
                of that run.
              </p>
            ) : null}
          </div>
        </div>
        <div className="mt-8 grid gap-5 sm:grid-cols-3">
          <Metric
            label={score.label}
            value={scoreUnavailable ? "Insufficient evidence" : `${format(score.value!)}%`}
            detail={
              counts
                ? `${counts.supported} supported / ${counts.contradicted} contradicted · ${score.resolvedClaimCount ?? counts.supported + counts.contradicted} resolved of ${score.selectedClaimCount ?? counts.eligibleFactualClaims} ${denominatorLabel}`
                : null
            }
          />
          <Metric
            label="Resolution coverage"
            value={
              score.resolutionCoverage === null
                ? "Not available"
                : `${format(score.resolutionCoverage * 100)}%`
            }
            detail={
              counts
                ? `${score.resolvedClaimCount ?? counts.supported + counts.contradicted} resolved / ${score.selectedClaimCount ?? counts.eligibleFactualClaims} ${denominatorLabel}`
                : null
            }
          />
          <Metric
            label="Evidence as of"
            value={new Date(view.asOfTime).toLocaleString()}
            detail={score.formulaVersion ?? "No score computed"}
          />
        </div>
        {view.focusedSelection ? (
          <p className="mt-5 text-sm text-ink-soft">
            Evidence analysis covers {view.focusedSelection.analyzedClaims} selected claim
            {view.focusedSelection.analyzedClaims === 1 ? "" : "s"} of{" "}
            {view.focusedSelection.inventoriedClaims} inventoried claims. Remaining claims stay
            visible as deferred or excluded work.
            {view.focusedSelection.shortfallReason
              ? ` ${view.focusedSelection.shortfallReason}`
              : ""}
          </p>
        ) : null}
        {view.focusedPublicationPolicy ? (
          <p className="mt-3 text-sm text-ink-soft">
            Focused checking uses evidence-gated decisions. Scores cover selected claims only.
          </p>
        ) : null}
        {counts ? (
          <p className="mt-5 text-sm text-ink-soft">
            {score.selectedClaimCount ?? counts.eligibleFactualClaims} {denominatorLabel} ·{" "}
            {score.resolvedClaimCount ?? counts.supported + counts.contradicted} resolved ·{" "}
            {counts.misleading} misleading · {counts.mixed} mixed · {counts.unverified} unverified ·{" "}
            {counts.deferredClaims} deferred · {counts.omittedClaims} omitted
          </p>
        ) : null}
        {score.nullReasons.length > 0 ? (
          <p className="trace-reading-caveat mt-3">
            <span>
              {scoreUnavailable ? "Insufficient evidence for a safe score" : "Score notes"}:{" "}
              {score.nullReasons.map(humanize).join(", ")}.
            </span>
          </p>
        ) : null}
      </header>

      {view.conflicts.length > 0 ? (
        <section className="trace-section" id="conflicts">
          <header className="trace-section-head">
            <h2 className="trace-section-title">Unresolved conflicts</h2>
            <p className="trace-section-count">{view.conflicts.length}</p>
          </header>
          <ul className="space-y-2 text-sm">
            {view.conflicts.map((conflict, index) => (
              <li key={`${conflict.claimId}:${index}`}>{conflict.description}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="trace-section" id="claims">
        <header className="trace-section-head">
          <h2 className="trace-section-title">Top claims selected for checking</h2>
          <p className="trace-section-count">{view.claims.length} of 3 max</p>
          <p className="trace-section-lede">
            Selected claims are the factual claims checked in this report. Extraction coverage{" "}
            {score.extractionCoverage === null
              ? "is unavailable"
              : `is ${format(score.extractionCoverage * 100)}%`}
            .
          </p>
        </header>
        <ol className="trace-claims">
          {view.claims.map((claim) => (
            <li key={claim.id} className="trace-claim">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>
                  {claim.publishedLabel ? humanize(claim.publishedLabel) : "Unresolved"}
                </Badge>
                {claim.focusedPublication ? (
                  <Badge
                    variant={claim.focusedPublication.status === "published" ? "violet" : "amber"}
                  >
                    Evidence gate: {humanize(claim.focusedPublication.gate)}
                  </Badge>
                ) : null}
                {claim.diagnosticLabel && claim.diagnosticLabel !== claim.publishedLabel ? (
                  <Badge variant="amber">Not published: {humanize(claim.diagnosticLabel)}</Badge>
                ) : null}
                {claim.conflict ? <Badge variant="rose">Conflict</Badge> : null}
              </div>
              <h3 className="mt-3 text-lg font-semibold">{claim.text}</h3>
              {claim.justification ? (
                <p className="mt-2 text-sm text-ink-soft">{claim.justification}</p>
              ) : null}
              {claim.evidence.length > 0 ? (
                <ul className="mt-4 space-y-2 text-sm">
                  {claim.evidence.map((item) => (
                    <li key={item.assessmentId} className="flex flex-wrap items-baseline gap-2">
                      <a
                        className="trace-external inline-flex"
                        href={item.excerptHref}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Evidence excerpt: “{item.quote}” <ExternalLink />
                      </a>
                      <span className="text-ink-faint">{humanize(item.relation)}</span>
                      {item.sourceUrl ? (
                        <a
                          className="text-ink-faint underline"
                          href={item.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          source link
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-ink-soft">
                  Evidence unavailable or unresolved for this claim.
                </p>
              )}
            </li>
          ))}
        </ol>
      </section>

      {view.deferredClaims.length > 0 ? (
        <section className="trace-section" id="deferred">
          <header className="trace-section-head">
            <h2 className="trace-section-title">Deferred work</h2>
            <p className="trace-section-count">{view.deferredClaims.length} not yet analyzed</p>
          </header>
          <ul className="space-y-2 text-sm">
            {view.deferredClaims.map((claim) => (
              <li key={claim.id}>
                <p>{claim.text}</p>
                {claim.reason ? <p className="text-xs text-ink-faint">{claim.reason}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.excludedClaims.length > 0 ? (
        <section className="trace-section" id="excluded">
          <header className="trace-section-head">
            <h2 className="trace-section-title">Excluded from focused factual work</h2>
            <p className="trace-section-count">{view.excludedClaims.length}</p>
            <p className="trace-section-lede">
              These inventoried items are retained for transparency but are not selected factual
              claims and do not affect the focused score.
            </p>
          </header>
          <ul className="space-y-2 text-sm">
            {view.excludedClaims.map((claim) => (
              <li key={claim.id}>
                <p>{claim.text}</p>
                {claim.reason ? <p className="text-xs text-ink-faint">{claim.reason}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.presentationFindings.length > 0 ? (
        <section className="trace-section" id="presentation">
          <header className="trace-section-head">
            <h2 className="trace-section-title">Presentation observations</h2>
            <p className="trace-section-count">{view.presentationFindings.length}</p>
            <p className="trace-section-lede">
              These observations describe presentation, attribution, or context. They do not change
              the factual verdict or score.
            </p>
          </header>
          <ul className="space-y-3 text-sm">
            {view.presentationFindings.map((finding) => (
              <li key={finding.id} className="border-t border-line-weak pt-3">
                <p className="font-semibold">{humanize(finding.kind)}</p>
                <p className="mt-1 text-ink-soft">{finding.description}</p>
                <p className="mt-1 text-xs text-ink-faint">
                  {finding.evidenceBacked
                    ? "Evidence-backed context"
                    : "Submitted-text observation only"}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="trace-section" id="source-context">
        {view.sourceContext.length > 0 ? (
          <>
            <header className="trace-section-head">
              <h2 className="trace-section-title">Source context</h2>
              <p className="trace-section-count">{view.sourceContext.length}</p>
              <p className="trace-section-lede">
                Provider ratings and discovery metadata are context only; they are not proof of a
                claim.
              </p>
            </header>
            <ul className="space-y-3 text-sm">
              {view.sourceContext.map((source) => (
                <li key={source.candidateId} className="border-t border-line-weak pt-3">
                  <a
                    className="trace-external inline-flex font-semibold"
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {source.title ?? source.url} <ExternalLink />
                  </a>
                  <p className="text-xs text-ink-faint">
                    {source.provider} · provider rating: {source.providerRating ?? "not supplied"}
                  </p>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <header className="trace-section-head">
              <h2 className="trace-section-title">Source context</h2>
              <p className="trace-section-count">Unavailable</p>
              <p className="trace-section-lede">
                No provider or source-reputation metadata was supplied. Source context is not
                evidence and does not affect the factual score.
              </p>
            </header>
          </>
        )}
      </section>

      <section className="trace-section" id="origin">
        <header className="trace-section-head">
          <h2 className="trace-section-title">Earliest-observed provenance</h2>
          <p className="trace-section-lede">
            Earliest observed within the searched scope; earlier material may exist outside it.{" "}
            {view.relatedContextNotice}
          </p>
        </header>
        {view.originCandidates.length === 0 ? (
          <p className="border-t border-line-weak py-4 text-sm text-ink-soft">
            Provenance unavailable; no claim-bearing source graph was supplied.
          </p>
        ) : (
          view.originCandidates.map((graph) => (
            <div key={graph.claimId} className="border-t border-line-weak py-4">
              <p className="text-sm font-semibold">{graph.claimText}</p>
              <ul className="mt-2 text-sm text-ink-soft">
                {graph.candidates.map((root) => (
                  <li key={`${root.snapshotId}:${root.rootKind}`}>
                    {humanize(root.rootKind)} · rank {root.rank}
                    {root.url ? ` · ${root.url}` : ""}
                  </li>
                ))}
                {graph.unresolved ? <li>Earliest observed source remains unresolved.</li> : null}
              </ul>
            </div>
          ))
        )}
      </section>

      {view.timeline.entries.length > 0 ? (
        <section className="trace-section" id="timeline">
          <header className="trace-section-head">
            <h2 className="trace-section-title">Observed timeline</h2>
            <p className="trace-section-count">{view.timeline.entries.length}</p>
            <p className="trace-section-lede">{view.timeline.notice}</p>
          </header>
          <ol className="space-y-3 text-sm">
            {view.timeline.entries.map((entry) => (
              <li key={entry.id} className="border-t border-line-weak pt-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-semibold">{humanize(entry.assertion.type)}</span>
                  <span>{formatTimelineInterval(entry.assertion.interval)}</span>
                  {entry.status === "unresolved" ? (
                    <Badge variant="amber">
                      Unresolved: {humanize(entry.unresolvedReason ?? "unknown")}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-xs text-ink-faint">
                  {humanize(entry.assertion.source)} · {humanize(entry.snapshotRole)} snapshot
                  {entry.sourceUrl ? ` · ${entry.sourceUrl}` : ""}
                </p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {view.visualVerification.ocr !== "not_applicable" ? (
        <section className="trace-section" id="visual-status">
          <header className="trace-section-head">
            <h2 className="trace-section-title">Screenshot text status</h2>
            <p className="trace-section-lede">
              {view.visualVerification.ocr === "uncertain"
                ? "Some visible text was transcribed with uncertainty. "
                : view.visualVerification.ocr === "unavailable"
                  ? "OCR was unavailable, so no image text was transcribed. "
                  : "Visible text was transcribed. "}
              OCR checks what the image says; it does not verify the depicted event, visual
              provenance, or authenticity. Missing EXIF/C2PA metadata or reverse-image matches is
              not evidence that the image is fabricated.
            </p>
            {view.visualVerification.observations.length > 0 ? (
              <ul className="mt-4 space-y-2 text-sm">
                {view.visualVerification.observations.map((observation) => (
                  <li
                    key={`${observation.snapshotId}:${observation.start}:${observation.end}`}
                    className="border-t border-line-weak pt-2"
                  >
                    <span>“{observation.text}”</span>
                    <span className="ml-2 text-xs text-ink-faint">
                      OCR region {observation.start}–{observation.end}
                      {observation.transcriptionUncertain ? " · transcription uncertain" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-3 text-xs text-ink-faint">
              Image authenticity is not assessed by OCR.
            </p>
          </header>
        </section>
      ) : null}

      {view.unresolvedReasons.length > 0 || view.status !== "complete" ? (
        <section className="trace-section" id="unresolved">
          <header className="trace-section-head">
            <h2 className="trace-section-title">Unresolved or unavailable evidence</h2>
            <p className="trace-section-lede">
              This run did not turn every requested check into a safe result. Provider failures,
              inaccessible sources, and uncertain extraction remain visible here.
            </p>
          </header>
          {view.unresolvedReasons.length > 0 ? (
            <ul className="space-y-2 text-sm">
              {view.unresolvedReasons.map((issue, index) => (
                <li key={`${issue.code}:${index}`} className="border-t border-line-weak pt-2">
                  <span className="font-semibold">{humanize(issue.code)}</span>
                  {issue.message ? (
                    <span className="ml-2 text-ink-soft">{issue.message}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-soft">No completed evidence report is available.</p>
          )}
        </section>
      ) : null}
    </article>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string | null }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
      {detail ? <p className="text-xs text-ink-faint">{detail}</p> : null}
    </div>
  );
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function format(value: number) {
  return Number(value.toFixed(1));
}

function formatTimelineInterval(interval: { earliest: string | null; latest: string | null }) {
  if (interval.earliest === null && interval.latest === null) return "Time unknown";
  const earliest = interval.earliest
    ? new Date(interval.earliest).toLocaleString()
    : "Unknown start";
  const latest = interval.latest ? new Date(interval.latest).toLocaleString() : "Unknown end";
  return earliest === latest ? earliest : `${earliest} – ${latest}`;
}
