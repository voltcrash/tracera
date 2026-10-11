# Stage 0 resource preparation

Date: 2026-10-11. Phase 0.3 is **incomplete**. R2 activation is verified; creation and
deployment commands were approved as a six-command batch. Google staging OAuth is deferred at the
owner's request. GitHub staging OAuth and the scoped CI token remain pending.

This phase follows section 3 and Phase 0.3 of the
[migration plan](cloudflare-migration-plan.md). Its PR contains documentation only.
Resource bootstrap artifacts live outside the repository and do not implement the product.
Do not advance to Stage 1 until the remaining Phase 0.3 requirements are resolved.

## Account and inventory

The selected Cloudflare account is `eb2679ce4f23ae7db4e6c4e3fcf8c3c1`, with the
`voltcrash.workers.dev` subdomain. Read-only Wrangler inventory found no Tracera D1
databases, Workers, or Workflows. The existing oxytype resources are separate.

The initial R2 list failed with error 10042 because R2 was disabled. After the owner
enabled R2 in the Dashboard, listing buckets succeeded and returned an empty inventory.
R2 activation is no longer the blocker. Approved resource creation is in progress.

## Staging resource manifest

| Resource      | Name or origin                                  | Binding             | ID and state                                            |
| ------------- | ----------------------------------------------- | ------------------- | ------------------------------------------------------- |
| Worker        | `tracera-staging`                               | —                   | Deployed; bootstrap version below                       |
| Public origin | `https://tracera-staging.voltcrash.workers.dev` | —                   | Verified HTTP 503 bootstrap response                    |
| D1            | `tracera-staging`                               | `DB`                | `4df15d26-839d-46aa-a7fa-341c228569c2`; created in APAC |
| R2            | `tracera-staging-blobs`                         | `BLOBS`             | Created; Standard storage, private bucket               |
| Workflow      | `tracera-staging-analysis`                      | `ANALYSIS_WORKFLOW` | Creation pending; class `AnalysisWorkflow`              |

Stage 2's default `apps/web/wrangler.jsonc` must use these hosted names and the real D1
UUID. Local development uses Miniflare copies in that worktree's `.wrangler/state`.
The all-zero UUID in the throwaway spike is valid only for local work and dry runs.

## Production resource manifest

| Resource             | Name or origin                  | Binding             | ID and state                                            |
| -------------------- | ------------------------------- | ------------------- | ------------------------------------------------------- |
| Worker               | `tracera`                       | —                   | Pending creation                                        |
| Future public origin | `https://tracera.voltcrash.com` | —                   | Custom-domain activation belongs to Stage 4             |
| D1                   | `tracera-production`            | `DB`                | `26eeb656-2c46-4182-ad48-4bd696684b01`; created in APAC |
| R2                   | `tracera-production-blobs`      | `BLOBS`             | Created; Standard storage, private bucket               |
| Workflow             | `tracera-production-analysis`   | `ANALYSIS_WORKFLOW` | Creation pending; class `AnalysisWorkflow`              |

Stage 2's separate `apps/web/wrangler.production.json` must use these resources. Production
disables workers.dev and preview URLs. The Stage 0 bootstrap also has an empty routes
array, so resource creation cannot claim the current Vercel hostname. Add the planned
custom-domain route only through Stage 4's approved cutover steps.

## Staging Worker deployment

The approved deployment created Worker `tracera-staging`, version
`375cd268-d98a-4a6c-9fae-6b9cb78c2e51`, with message `Stage 0 resource bootstrap`.
Its cron is `17 * * * *`. The deployed artifact is 0.75 KiB before gzip.

An HTTPS request to the staging origin returned HTTP 503, `cache-control: no-store`, and
`{"service":"tracera","stage":0,"status":"migration-pending"}`. This is the intended
bootstrap response. Authentication and analysis are implemented in later stages.
