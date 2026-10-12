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

## Phase 1.2 — Provider resolver and redaction

Result: **PASS** locally, 2026-10-12.

`resolveAnalysisProvider({ userId, env })` returns platform configuration from typed inputs,
with generation settings, paired embedding credentials, compatible-provider base URLs and
Anthropic's separate embedding provider validated in one place. The existing runtime policy
calls the resolver with the authenticated user ID.

Run contexts carry only provider name and key source beside the existing model version. The
report contract is unchanged. `providerSpendIdentity` selects the actual generation or
embedding provider and keeps the key source separate for the D1 spend tables added in Phase
1.3. Existing Postgres spend rows retain their current namespace during additive Stage 1.

Provider HTTP, transport, JSON and structured-output failures discard upstream text and error
causes. Observability hooks receive fixed validation messages. Cross-origin redirects strip
all provider authentication headers. Unit and workerd tests echo sentinel keys in upstream
errors and verify that neither errors nor logs retain them; successful provider probes verify
that keys appear only in headers.

Validation: `vp install`, `vp check`, `vp test --run` (226 passed; 10 existing Postgres cases
skipped by the unit runner), `vp run check-types` and `vp run build` pass. Evidence:
`resolve-analysis-provider.test.ts`, `provider-spend-identity.test.ts`, `provider-request.test.ts`,
`provider.test.ts`, `worker-provider-redaction.test.ts` and the run-context assertions in
`apps/web/test/analysis-api.test.ts`.

[Phase 1.1 PR #36](https://github.com/voltcrash/tracera/pull/36) also passed hosted CI, including
the existing Docker integration workflow and Vercel build.

## Phase 1.3 — D1 schema and baseline

Result: **PASS** locally, 2026-10-12.

The SQLite schema contains 21 live tables. It uses text IDs, application-generated
millisecond timestamps, JSON text with hashes, boolean integers, integer micro-dollar spend,
and real factual scores. Jobs, outbox, embeddings and execution-lease columns are absent.
Admission leases remain for concurrency controls; they do not execute analysis work.

Better Auth's current `auth` CLI generated the four auth tables. Reconciliation retains
application-generated IDs and timestamps, unique provider/account identities and expiry
indexes. Regenerate a comparison copy with:

```sh
vp exec --filter @repo/db auth generate --config auth-schema.d1.config.ts --adapter drizzle --dialect sqlite --output ../../tmp/auth-schema.sqlite.ts --yes
```

`vp run @repo/db#db:generate:d1` generates `packages/db/migrations/0000_baseline.sql` using
`drizzle.d1.config.ts`. A second generation reports no schema changes. Both Wrangler configs
point to that folder and use the real, isolated resource IDs from Stage 0. They contain D1
foundations only; Phase 2.1 adds the app entry, remaining bindings and hosting configuration.

The oxytype-style `createTestRuntime` applies the real SQL migrations to fresh Miniflare D1.
Seven tests cover all live tables, retired-table exclusions, dates and booleans, whole-batch
rollback, OAuth account uniqueness, provider/source spend separation, ownership foreign keys
and exclusive inline/R2 payload storage.

Wrangler applied the baseline to local staging state in `apps/web/.wrangler/state`: all 45
SQL commands succeeded. The production config also applied all 45 commands to an isolated
local test copy under `apps/web/.wrangler/production-migration-test`. Both commands used
`--local`; neither hosted database was migrated. Reapplying the staging task reports no
migrations to apply.

Validation: `vp install`, `vp check`, `vp test --run` (233 passed; 10 existing Postgres cases
skipped by the unit runner), `vp run check-types`, `vp run @repo/db#db:generate:d1`,
`vp run @repo/db#db:migrate:d1` and `vp run build` pass. Evidence:
`packages/db/test/d1/schema.test.ts`, the generated baseline, and both Wrangler local runs.

[Phase 1.2 PR #37](https://github.com/voltcrash/tracera/pull/37) passed hosted CI and the Vercel
build. No hosted resources, credentials or OAuth apps were changed in Phase 1.3.

## Remaining phases

Phases 1.4–1.5 have not started. Each gets its own stacked PR with validation and evidence
recorded here before its handoff.
