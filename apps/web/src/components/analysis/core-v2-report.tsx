"use client";

import type { CoreV2ReportView } from "@repo/ai/core/report-view";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function CoreV2Report({ view }: { view: CoreV2ReportView }) {
  const { score } = view;
  const counts = score.counts;

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
            value={score.value === null ? "Not available" : `${format(score.value)}%`}
            detail={
              counts
                ? `${counts.supported} supported / ${counts.supported + counts.contradicted} resolved`
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
            detail={counts ? `${counts.eligibleFactualClaims} eligible factual claims` : null}
          />
          <Metric
            label="Evidence as of"
            value={new Date(view.asOfTime).toLocaleString()}
            detail={score.formulaVersion}
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
            Focused evidence gate {view.focusedPublicationPolicy.policyVersion} · decision boundary{" "}
            {view.focusedPublicationPolicy.decisionVersion} · statistical calibration not used.
          </p>
        ) : null}
        {counts ? (
          <p className="mt-5 text-sm text-ink-soft">
            {counts.misleading} misleading · {counts.mixed} mixed · {counts.unverified} unverified ·{" "}
            {counts.deferredClaims} deferred · {counts.omittedClaims} omitted
          </p>
        ) : null}
        {score.nullReasons.length > 0 ? (
          <p className="trace-reading-caveat mt-3">
            No summary score: {score.nullReasons.map(humanize).join(", ")}.
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
          <h2 className="trace-section-title">Claim coverage</h2>
          <p className="trace-section-count">{view.claims.length} analyzed</p>
          <p className="trace-section-lede">
            Extraction coverage{" "}
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
                <Badge>{humanize(claim.publishedLabel ?? claim.disposition)}</Badge>
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
                        “{item.quote}” <ExternalLink />
                      </a>
                      <span className="text-ink-faint">{humanize(item.relation)}</span>
                      {item.sourceUrl ? (
                        <a
                          className="text-ink-faint underline"
                          href={item.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          source
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
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
              <li key={claim.id}>{claim.text}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="trace-section" id="origin">
        <header className="trace-section-head">
          <h2 className="trace-section-title">Origin candidates</h2>
          <p className="trace-section-lede">
            Earliest observed within the recorded search scope, never a global first source.{" "}
            {view.relatedContextNotice}
          </p>
        </header>
        {view.originCandidates.map((graph) => (
          <div key={graph.claimId} className="border-t border-line-weak py-4">
            <p className="text-sm font-semibold">{graph.claimText}</p>
            <ul className="mt-2 text-sm text-ink-soft">
              {graph.candidates.map((root) => (
                <li key={`${root.snapshotId}:${root.rootKind}`}>
                  {humanize(root.rootKind)} · rank {root.rank}
                  {root.url ? ` · ${root.url}` : ""}
                </li>
              ))}
              {graph.unresolved ? <li>Origin unresolved.</li> : null}
            </ul>
          </div>
        ))}
      </section>

      {view.visualVerification.ocr !== "not_applicable" ? (
        <section className="trace-section" id="visual-status">
          <header className="trace-section-head">
            <h2 className="trace-section-title">Image verification status</h2>
            <p className="trace-section-lede">
              {view.visualVerification.ocr === "uncertain"
                ? "Some visible text was transcribed with uncertainty. "
                : "Visible text was transcribed. "}
              OCR checks what the image says; it does not verify the depicted event, visual
              provenance, or authenticity.
            </p>
          </header>
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
