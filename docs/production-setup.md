# Production setup

Production uses one Worker at `https://tracera.voltcrash.com` and the explicit
`apps/web/wrangler.production.json` config. The repository is prepared for this runtime;
cutover has not happened. Production workers.dev and preview URLs are disabled.

| Resource               | Production                                                   |
| ---------------------- | ------------------------------------------------------------ |
| Worker / custom domain | `tracera` / `tracera.voltcrash.com`                          |
| D1                     | `tracera-production`, `26eeb656-2c46-4182-ad48-4bd696684b01` |
| R2                     | `tracera-production-blobs`                                   |
| Workflow               | `tracera-production-analysis`                                |

The Cloudflare custom domain replaces the existing hosting DNS record only during the approved
Phase 4.2 cutover. Production begins with an empty D1: accounts and history reset, with no
legacy import or write freeze. Initial sign-in uses GitHub; Google completion comes last.

## Private settings

Create ignored `apps/web/.dev.vars.production` from the production example and preserve the
independent auth secret generated in Stage 0. Use mode `0600` and complete production GitHub
credentials. Credentials must differ from staging, and placeholders fail checks. Preserve the
deployed auth secret on subsequent releases. Omit `DEV_AUTH_BYPASS`.

AI is optional under D18. Without any AI provider setting, production serves sign-in, history,
and settings while analysis reports that it is unavailable, and `check:production` says so.
To enable analysis, add the provider, generation and embedding models, keys, and every run and
spend bound together; a partial configuration fails the check.

The production GitHub OAuth app was created fresh for Cloudflare on 2026-10-12, with homepage
`https://tracera.voltcrash.com` and callback
`https://tracera.voltcrash.com/api/auth/callback/github`. Google may be entirely absent until Phase 4.4; partial configuration fails.
Non-secret operational settings belong in reviewed Wrangler vars when practical.

## Local preflight

With the complete private file available:

```sh
vp install
vp check
vp test --run
vp run check:production
vp run deploy:production-dry-run
```

`check:production` builds against the production config and checks the resulting Worker,
isolated resources, secrets, live analysis, and budgets. Dry-run packages and validates without
uploading. Do not reuse a staging build for production.

## Daily production release

The [production release workflow](../.github/workflows/production-release.yml) runs daily at
`00:17 UTC` and supports manual dispatch from `main`. Configure the GitHub `production` environment and these secrets only
through an approved owner action:

| Secret                  | Value                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Token scoped to the selected production account and required Worker/D1/custom-domain operations |
| `PRODUCTION_WORKER_ENV` | Full contents of the private `.dev.vars.production` file                                        |

The workflow plans first. Without commits since the last successful production release it
skips install, build, migration, deployment, and publication. Otherwise it uses the current UTC
execution date as `YY.MM.DD`, checks its `v`-prefixed tag for collisions, writes the private file
with mode `0600`, validates/builds/dry-runs, applies production D1 migrations, and deploys with
the version var. It publishes the exact deployed commit only after success and always removes
the private file. It never resets or bootstraps D1. A second changed snapshot on the same UTC
date cannot reuse that date's tag. Keep the deployed date tag immutable and dispatch on the
next UTC date; an urgent exception requires an explicit release-policy change in a reviewed PR.

The first approved cutover release is started with:

```sh
gh workflow run production-release.yml --repo voltcrash/tracera --ref main
```

This is a hosted deployment command, not a validation command. Do not dispatch it before
Stage 4 sign-off and the approved DNS change. The first successful release establishes the
baseline for subsequent daily runs.

## Cutover and recovery

The rollout runbook records the reset announcement, Vercel auto-deploy disablement, integration
branch merge, DNS removal, release dispatch, GitHub smoke test, and 24–48-hour observation.
Before decommission, rollback can remove the Worker custom domain and restore the prior DNS
record. Writes made on Cloudflare do not move back into the old database. Keep the rollback
window short and explicit. Decommission, key rotation, a D1 restore drill, and final Google
OAuth each retain their own approvals and signed results.
