# Stage 1 Cloudflare foundations

Stage 1 follows the phase order and exit criteria in the
[accepted migration plan](cloudflare-migration-plan.md). The existing Next.js/Vercel app
continues using Postgres until the later framework swap.

## Phase 1.1 — Worker-safe AI runtime

Result: **PASS** locally, 2026-10-12.

- `safeFetch` shares URL, DNS-answer, IP-literal, port and redirect validation. Workers select
  the Web `fetch` transport through the `workerd` package condition. The default Node
  transport retains socket-level DNS pinning for Vercel.
- The owner approved this rollout correction on 2026-10-12. Phase 2.1 removes the temporary
  Node transport and package mapping after switching the migration branch's app to Workers.
  This avoids relying on Workers' private-network boundary while the app still runs on Vercel.
- `createR2RawBlobStore` stores raw bytes at `snapshots/<snapshotId>/<sha256>`, returns `r2://`
  locators, verifies content hashes on reads, rejects malformed locators and checks cancellation.
  The filesystem implementation now lives only in test support.
- Miniflare runs ingestion, R2 storage and every provider adapter inside workerd. The provider
  probes cover structured generation, image generation and supported embeddings with stubbed
  upstreams. DNS requests are stubbed at the runtime's outbound service, preserving the real
  `node:dns` path rather than replacing the resolver inside the application.
- The ingestion bundle selects Cheerio's browser export. Bundle assertions exclude its
  Node-only fetching dependencies and the legacy Node transport.

Validation: `vp install`, `vp check`, `vp test --run`, `vp run check-types`,
`vp run @repo/ai#test:analysis-ingestion` and `vp run build` pass. The full unit run has
206 passing tests; 10 existing Postgres integration cases are skipped by the normal unit
runner. Local Docker is unavailable, so the existing Docker integration workflow is left
for PR CI. No new Worker tests are skipped.

The direct Miniflare dependency is the newest stable release, `4.20260730.0`; its registry
`latest` tag is an alpha. Smoke tests use its supported compatibility date `2026-07-30` with
`nodejs_compat`, matching the Stage 0 test-runtime pattern.

No hosted resources, secrets, deployments, DNS or OAuth apps were changed. The deployed
provider-network probe remains required before configuring a live provider, as recorded in
Stage 0. These stubbed tests prove runtime compatibility, not hosted provider access.

Evidence: `packages/ai/test/worker-ingestion.test.ts`, `worker-providers.test.ts`,
`worker-safe-fetch.test.ts`, `node-safe-fetch.test.ts` and `r2-raw-blob-store.test.ts`.

## Remaining phases

Phases 1.2–1.5 have not started. Each gets its own stacked PR with validation and evidence
recorded here before its handoff.
