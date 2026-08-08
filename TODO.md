# Tracera implementation backlog

This is the working backlog derived from the product requirements in
[`AGENTS.md`](./AGENTS.md). Items are ordered by delivery dependency rather
than by screen.

## P0 — make the product dependable

- [x] Restore a clean monorepo quality gate: type-check, lint, build, and
  automated tests must all run in CI.
- [ ] Validate the selected local Gemma model with 5–10 real, mixed-veracity
  news articles; record schema-conformance, claim-atomicity, and verdict
  quality results before relying on it for production decisions.
- [ ] Make text/link/image normalization trustworthy: safe URL fetching and
  readable extraction, real OCR, EXIF extraction, and reverse-image-search
  integration.
- [ ] Strengthen retrieval: retrieve source content, use a defined web-search
  adapter, seed and maintain domain trust data, and keep evidence relevant.
- [x] Persist reproducible audit records: full prompts, model/provider
  metadata, retry outcomes, and retrieved-source snapshots.
- [ ] Calibrate claim verdict, evidence-quality, and aggregate-score logic
  against labelled evaluation cases.

## P1 — complete the trace lifecycle

- [ ] Implement Ground Zero tracing beyond earliest retrieved timestamp:
  publisher dates, citations/reposts, corpus history, and confidence labels.
- [ ] Finalize exact-dedup and related-context policies, thresholds, cache
  expiry, and user-facing reuse/re-analysis states.
- [ ] Build trace history: link rechecks with `supersedes_check_id`, compare
  verdict/score changes, and expose timeline events in web and mobile.
- [ ] Complete decay monitoring with durable retries, change detection,
  observability, and scheduled rechecks.
- [ ] Deliver opt-in alerts: subscription management and notification delivery
  when a trace materially changes.
- [ ] Add News Hub search, pagination, source/domain metadata, re-analysis
  states, and appropriate ownership/privacy access controls.

## P2 — finish platform capabilities

- [ ] Add web image upload/camera input and image-result provenance details.
- [ ] Bring mobile to feature parity: durable auth session, Ground Zero,
  timeline, alerts, and complete evidence details.
- [ ] Build the reactive extension experience: content-script claim detection,
  inline highlights, explanations, and recheck updates.
- [ ] Add account hardening: password reset, email verification, session
  management, and rate/abuse protection.
- [ ] Build opt-in personal media-diet reports and delivery preferences.

## P3 — public product readiness

- [ ] Define the public API after pipeline stability: documented endpoints,
  scoped API keys, quotas, versioning, and abuse controls.
- [ ] Add deployment configuration, CI/CD, migrations/rollback practice,
  metrics, logging, tracing, and incident alerts.
- [ ] Establish data-retention, consent, privacy, and source-attribution
  policies.
