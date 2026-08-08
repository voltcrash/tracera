# Tracera implementation backlog

This is the working backlog derived from the product requirements in
[`AGENTS.md`](./AGENTS.md). Items are ordered by delivery dependency rather
than by screen.

## P0 — make the product dependable

- [ ] Strengthen retrieval: retrieve source content, use a defined web-search
      adapter, seed and maintain domain trust data, and keep evidence relevant.
- [ ] Calibrate claim verdict, evidence-quality, and aggregate-score logic
      against labelled evaluation cases.

## P2 — finish platform capabilities

- [x] Add web image upload/camera input and image-result provenance details.
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

## F0 — externally dependent future work

- [ ] Install and validate a production local model (`gemma2:9b` and, if
      hardware permits, `gemma2:27b`) against 5–10 real mixed-veracity articles.
      Record schema conformance, claim atomicity, verdict quality, and latency
      before enabling it for production decisions.
- [ ] Configure a real OCR provider, EXIF parser, and reverse-image-search
      provider. The web/mobile image upload path and optional OCR endpoint contract
      are in place; the forensic integrations require provider credentials and
      service selection.
