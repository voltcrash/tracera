# Cloudflare rollout runbook

This is reviewable preparation for Stage 4, not a record of completed hosted work. Follow the
[migration plan](cloudflare-migration-plan.md) in phase order. The owner deferred the Phase 2.6
live-provider test until repository implementation is finished. Deployments, secret uploads,
DNS/OAuth changes, and decommission require approval of concrete actions before execution.

| Gate                          | Status                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| Phase 2.6 local live analysis | Deferred by the owner under D18                                                                           |
| Phase 4.1 staging soak        | Deployed and smoke-checked under D18; owner GitHub round trip and provider checks remain                  |
| Phase 4.2 production cutover  | Live on `v26.10.12` under D18; owner GitHub round trip remains                                            |
| Phase 4.3 decommission        | Vercel gone and restore drills passed; Neon archive and deletion and the Vercel GitHub App removal remain |
| Phase 4.4 Google OAuth        | Pending final registration/credential approval, code PR, deploy, browser sign-off                         |

Record dates, reviewers, commit/Worker versions, run IDs, and outcomes beneath each gate.
Keep keys, OAuth secrets, cookies, private inputs, and logs containing private data outside Git.
Commands using `RUN_ID`, `BOOKMARK`, or private paths are templates; resolve them before
presenting an exact approval batch. The following commands have not been executed here.

## Stage 4 preflight

Read-only checks on 2026-10-12 from `migrate/cloudflare` at `df9f8f7`, before any Stage 4
hosted change. Wrangler ran with the scoped CI token against account
`eb2679ce4f23ae7db4e6c4e3fcf8c3c1`.

| Staging resource           | Observed state                                                               |
| -------------------------- | ---------------------------------------------------------------------------- |
| Worker `tracera-staging`   | Stage 0 bootstrap version `375cd268`; the workers.dev URL returns 503        |
| D1 `tracera-staging`       | `4df15d26-…`, empty; `0000_baseline` and `0001_provider_spend_guard` pending |
| R2 `tracera-staging-blobs` | Present                                                                      |
| `tracera-staging-analysis` | Present, bound to script `tracera-staging` and class `AnalysisWorkflow`      |

| Production resource           | Observed state                                                      |
| ----------------------------- | ------------------------------------------------------------------- |
| Worker `tracera`              | Stage 0 bootstrap version `9a424fa8`; no custom domain attached yet |
| D1 `tracera-production`       | `26eeb656-…`, empty; the same two migrations pending                |
| R2 `tracera-production-blobs` | Present                                                             |
| `tracera-production-analysis` | Present, bound to script `tracera` and class `AnalysisWorkflow`     |

Local validation at the same commit: `vp install`, `vp check`, and `vp test --run` (442 tests,
62 files) pass, and `vp run web#deploy:staging-dry-run` packages 3.9 MiB (0.9 MiB gzip) with
the `ANALYSIS_WORKFLOW`, `DB`, and `BLOBS` bindings and the staging `MODE=production`,
`ANALYSIS_MODE=live`, and `BETTER_AUTH_URL` vars.

The private Stage 0 files are mode 0600 in a mode-0700 directory. Checked by setting name only:

| Private file           | Present                                                          | Missing before hosted use                                    |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `.dev.vars.staging`    | `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | AI provider, models and keys; every run and spend bound      |
| `.dev.vars.production` | `BETTER_AUTH_SECRET`                                             | Production GitHub pair; AI provider, models and keys; bounds |

Neither ignored `apps/web/.dev.vars.staging` nor `apps/web/.dev.vars.production` exists in
this worktree yet. Hosted `MODE=production` with `ANALYSIS_MODE=live` requires the provider
settings and bounds, so staging cannot be deployed usefully until the owner chooses them.

## Phase 4.1 — Staging soak

1. Complete the deferred local `vp run dev:live` analysis with owner-configured provider/model
   settings and explicit run/spend bounds in `.dev.vars`. Record its result and usage.
2. Prepare `.dev.vars.staging`, preserving the Stage 0 auth secret and completed staging GitHub
   registration. Review the complete credentials and budget setting names without displaying
   their values. Use the [staging guide](staging-setup.md).
3. Present and approve this hosted batch before running it:

```sh
vp exec --filter web -- wrangler secret bulk .dev.vars.staging --config wrangler.jsonc
vp run deploy:staging
```

4. Record the deployed commit, Worker version, applied D1 migrations, and test window. Use real
   GitHub sign-in and bounded real-provider inputs for the checks below.

- [ ] GitHub callback succeeds; reload retains the session; sign-out clears it.
- [ ] Settings show linked accounts and run history belongs to the signed-in owner.
- [ ] Text, public-link, and screenshot analyses persist reports and exact evidence.
- [ ] Progress streaming survives reload; terminal states match the stored run.
- [ ] Cancellation reaches the Workflow instance and releases admission/spend state.
- [ ] An injected or observed retry resumes from a checkpoint without duplicate finalization.
- [ ] Replayed requests preserve their idempotency key and return the same stored response.
- [ ] Conflicting keys, rate/concurrency limits, daily quota, and spend circuit fail as intended.
- [ ] Browser console and network checks show no CSP violations or private-secret exposure.
- [ ] Worker logs, Workflow instances, D1 metrics, and provider usage reconcile with test runs.
- [ ] Required live evaluation prerequisites are met and its real results are recorded.

Read-only diagnostics after deployment:

```sh
vp exec --filter web -- wrangler tail --config wrangler.jsonc
vp exec --filter web -- wrangler workflows instances describe tracera-staging-analysis RUN_ID --json
vp exec --filter web -- wrangler d1 info tracera-staging --config wrangler.jsonc
```

Use temporary staging control values only through an approved change, then restore the
reviewed normal values. Do not stress-test with an unbounded provider account. The full release
evaluator currently implements fixture mode only. A live runner/connector implementation and
reference cases must be reviewed before its live check can run, along with credentials and
authorization; fixture metrics cannot close this gate.

Sign-off: **pending**. Record reviewer, UTC window, model names, approved bounds, input types,
run/instance IDs, verdict/evidence checks, observed usage, and any unresolved failures.

### Staging deployment, 2026-10-12

The owner directed the deployment under D18. The scoped CI token uploaded
`BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET` from the private staging
file with `wrangler secret bulk`; no AI settings were uploaded. `vp run deploy:staging` from
`migrate/stage-4-4.1-staging-soak` at `db77d7a` applied `0000_baseline` and
`0001_provider_spend_guard` to remote `tracera-staging`, then deployed Worker version
`9d53b87f-4056-4515-a178-058e7eec1ccf` with the hourly cron and `tracera-staging-analysis`.

Provider-free smoke checks against the deployed staging Worker:

| Check                                           | Result                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `/` and `/auth/error`                           | 200 with per-request CSP nonce and `x-request-id`                    |
| `/api/health`                                   | 200, `{"status":"ok","services":{"database":"connected"}}`           |
| `/home` and `/settings` while signed out        | 307 to `/`                                                           |
| Sign-in page providers                          | Only "Continue with GitHub"; Google returns `PROVIDER_NOT_FOUND`     |
| GitHub sign-in start                            | Redirects to `github.com/login` with the staging client and callback |
| Chromium console on `/`, `/auth/error`, `/home` | No errors and no CSP violations                                      |
| Analysis without a provider                     | Covered by the `startAnalysisRun` unavailable test; returns 503      |

Phase 4.1 sign-off under D18: **passed for provider-free automated checks**, 2026-10-12. The
automation browser has no GitHub session, so the owner's real GitHub round trip (callback,
reload, settings linked accounts, sign-out) is the one manual check left. Every analysis,
control, spend, and live-evaluation item waits for a configured provider.

## Phase 4.2 — Production cutover

Start only after Phase 4.1 sign-off. Review the actual current DNS record and Vercel project
settings before approval, and retain their exact values for rollback.

Suggested current-site announcement:

> Tracera is moving to Cloudflare. Accounts and report history will reset at cutover.
> The initial rollout uses GitHub sign-in; Google sign-in returns after the final setup phase.

Publish the announcement through the approved current-site change. Prepare production
credentials and the GitHub `production` environment using the [production guide](production-setup.md).
Preserve the generated production auth secret and the existing production GitHub callback.
Approval must cover environment/secret setup as well as deployment; merging code alone does
not approve credential or DNS changes.

Approved setup command templates:

```sh
gh api --method PUT repos/voltcrash/tracera/environments/production
gh secret set CLOUDFLARE_API_TOKEN --repo voltcrash/tracera --env production < /PRIVATE_PATH/cloudflare-token
gh secret set PRODUCTION_WORKER_ENV --repo voltcrash/tracera --env production < apps/web/.dev.vars.production
```

The repository already has `Preview` and `Production` environments from the Vercel
integration, with no protection rules, branch policy, or secrets. GitHub environment names are
case-insensitive, so the release workflow's `production` job and the `PUT` above both use the
existing `Production` environment. The repository has no Actions secrets yet.

Then perform the plan's cutover order:

1. Turn off Vercel Git deployments for the verified Tracera project. Record the setting and
   previous integration so rollback can restore it.
2. Merge the reviewed migration stack into `migrate/cloudflare`, then merge its reviewed cutover
   PR into `main`. Require the integrated CI result before the merge.
3. Remove only the verified Vercel DNS record for `tracera.voltcrash.com`. Present its zone ID,
   record ID, type, name, and current target in the approval batch; save them for rollback.
4. Dispatch the first production release:

```sh
gh workflow run production-release.yml --repo voltcrash/tracera --ref main
```

5. Verify the release deployed the expected SHA, migrated the empty production D1, and published
   its date tag after deployment. Run a real GitHub sign-in and bounded analysis smoke test.
6. Observe Worker errors/latency, auth callbacks, Workflow outcomes, D1, R2, and provider usage
   for 24–48 hours. Google remains deferred until Phase 4.4.

Resolve hosted project/zone/record identifiers with read-only inventory before drafting their
exact write commands. Placeholder deletion commands are not an approved action.

Observed on 2026-10-12: `voltcrash.com` is served by Cloudflare nameservers (zone
`80d71d02a1ef8a833c5502e31dd5ee6f`). Public DNS answers `tracera.voltcrash.com` with a
DNS-only `CNAME` to `938bc3975bc3bd4e.vercel-dns-017.com` (TTL 300), and the site serves the
Next.js build. Neither the CI token nor the local Wrangler login can read DNS records, so the
record ID must come from the owner's dashboard or a token with DNS read before step 3.

Before decommission, rollback removes the Worker custom domain and restores the saved Vercel
DNS record and Git integration. Review and approve the exact rollback actions first. Old data
remains in Neon; Cloudflare-era accounts/history stay in D1 and are not imported back. Record
this limitation and the agreed rollback window before cutover.

### Cutover preparation, 2026-10-12

The owner directed an immediate cutover and waived the announcement, the observation window,
and the rollback window (D18). Actual order:

1. The owner deleted the Vercel project, which ends Vercel Git deployments.
2. The owner attached `tracera.voltcrash.com` to the production Worker `tracera` as a custom
   domain (`e16f272b…`); public DNS now resolves to Cloudflare. The bootstrap version served
   503 until the first release.
3. The Vercel-created `Preview` and `Production` GitHub environments were deleted at the
   owner's direction. A fresh `production` environment deploys from `main` only and holds
   `CLOUDFLARE_API_TOKEN` (the scoped CI token) and `PRODUCTION_WORKER_ENV`.
4. The owner created a fresh production GitHub OAuth app. The private production file holds
   its pair and the Stage 0 auth secret, with no AI settings. Locally, `check:production`
   passed with the D18 notice and `deploy:production-dry-run` showed the production bindings.

### First production release, 2026-10-12

[PR #56](https://github.com/voltcrash/tracera/pull/56) merged `migrate/cloudflare` into `main`
at `b9397c9` after its CI passed. The manually dispatched
[release run](https://github.com/voltcrash/tracera/actions/runs/38288558499) built and checked
production with the D18 notice, dry-ran, applied `0000_baseline` and
`0001_provider_spend_guard` to the empty `tracera-production`, deployed Worker version
`b415862b-c97b-4cf8-a9ca-46a1219235b3`, and then published
[`v26.10.12`](https://github.com/voltcrash/tracera/releases/tag/v26.10.12) on `b9397c9`.

Production smoke checks after the release:

| Check                                           | Result                                                       |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `/`, `/auth/error`                              | 200                                                          |
| `/api/health`                                   | 200, database connected                                      |
| `/home` while signed out                        | 307 to `/`                                                   |
| GitHub sign-in start                            | Redirects to `github.com/login` with the production callback |
| Chromium console on `/`, `/auth/error`, `/home` | No errors and no CSP violations                              |
| `tracera.voltcrash.workers.dev`                 | 404; workers.dev stays disabled                              |

A second dispatch, [run 38288765452](https://github.com/voltcrash/tracera/actions/runs/38288765452),
found no new commits and skipped install, build, migration, deployment, and publication.
That closes the hosted skip-path check left open by Phase 3.3.

Phase 4.2 sign-off under D18: **passed**, 2026-10-12. The owner waived the announcement,
observation window, and rollback window. As in staging, the owner's real GitHub round trip is
the remaining manual check.

Sign-off: **pending**. Record announcement/approval links, integration and deployed SHAs,
release/tag URL, DNS record inventory, GitHub smoke result, observation window, and rollback
owner. Decommission must not begin while production stability is unresolved.

## Phase 4.3 — Decommission

Start only after the agreed stable period and an explicit owner decision to close rollback.
Inventory the exact Neon and Vercel project IDs and obsolete GitHub secret names with
read-only tools. Approve archive, deletion, key rotation, secret removal, and restore actions
separately from the earlier deployment batch.

Create a final private archive using a PostgreSQL client compatible with the source server.
Keep credentials in a mode-0600 service file rather than command arguments:

```sh
umask 077
PGSERVICEFILE=/PRIVATE_PATH/pg_service.conf pg_dump --dbname=service=tracera-archive --format=custom --file=/PRIVATE_PATH/tracera-neon-final.dump
shasum -a 256 /PRIVATE_PATH/tracera-neon-final.dump > /PRIVATE_PATH/tracera-neon-final.dump.sha256
vp exec --filter web -- wrangler r2 object put tracera-production-blobs/archive/neon-final-ARCHIVE_DATE.dump --remote --config wrangler.production.json --file /PRIVATE_PATH/tracera-neon-final.dump
vp exec --filter web -- wrangler r2 object put tracera-production-blobs/archive/neon-final-ARCHIVE_DATE.dump.sha256 --remote --config wrangler.production.json --file /PRIVATE_PATH/tracera-neon-final.dump.sha256
```

Resolve `ARCHIVE_DATE` and private paths before approval. Verify the remote archive and checksum
through an approved download before deleting the source. The private R2 archive is for reference;
no migration imports it into D1.

After archive verification, delete only the approved Neon and Vercel projects and their
variables. Rotate AI provider keys previously held by Vercel, update the private production
file and `PRODUCTION_WORKER_ENV`, and remove reviewed obsolete GitHub secrets. Preserve active
Cloudflare, production auth/OAuth, and new provider credentials. Recheck a bounded production
analysis after the approved credential update.

### D1 restore drill

Use [Time Travel recovery](cloudflare-operations.md#d1-capacity-and-time-travel). Agree on a
maintenance/write-pause procedure and inspect active Workflow instances before restoring;
pausing browser traffic alone does not pause Workflows or Cron. Record a baseline export and
current bookmark. Rehearse on staging first, then approve the production drill's exact database
and bookmark, maintenance actions, restore, verification, and undo commands.

```sh
vp exec --filter web -- wrangler d1 time-travel info tracera-production --config wrangler.production.json --json
vp exec --filter web -- wrangler d1 time-travel restore tracera-production --config wrangler.production.json --bookmark BOOKMARK --json
```

Record the previous bookmark returned by the restore and retain it for undo. Confirm expected
rows, schema-compatible code, R2 pointers, auth, ownership isolation, history, idempotency,
limits, and a bounded Workflow analysis before resuming writes. D1 recovery does not recreate
R2 objects or restart terminated instances.

### Vercel decommission, 2026-10-12

The owner deleted the Vercel project, including its variables, before cutover. The
Vercel-created GitHub `Preview` and `Production` environments were deleted at the owner's
direction. The repository has no Actions secrets or variables at repository level, so no
Vercel or Neon secret remains in GitHub. Phase 0.2 confirmed no AI provider keys were
configured, so there were no Vercel-held provider keys to rotate.

The Vercel GitHub App is still installed on the repository. It keeps posting `Preview`
deployments, which recreated that environment after its deletion. Removing the app needs the
owner's GitHub settings; then delete the `Preview` environment again.

### D1 restore drills, 2026-10-12

Both databases had no users, sessions, or runs, so no write pause was needed. Each drill
recorded a baseline bookmark, inserted an already-expired `verifications` canary row
(`identifier = 'restore-drill-canary'`), restored to the baseline with
`wrangler d1 time-travel restore`, then rechecked the canary, users, migrations, and
`/api/health`.

| Step              | `tracera-staging`                                             | `tracera-production`                                          |
| ----------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| Baseline bookmark | `00000004-00000000-00005102-c8ea53b112e026e7013fe12036f764cc` | `00000003-00000000-00005102-775edc09af2270cd96e4888f301e1eff` |
| Canary rows       | 1 after insert, 0 after restore                               | 1 after insert, 0 after restore                               |
| Restore duration  | 3 s                                                           | 3 s                                                           |
| Undo bookmark     | `00000004-ffffffff-00005102-f3346fd8291f3c297d99301d723cdc86` | `00000003-ffffffff-00005102-1b23c1e0c64ecc1313ce1bbb7e9d29d5` |
| After restore     | Users 0; no migrations pending; health reports D1 connected   | Users 0; no migrations pending; health reports D1 connected   |

Sign-off: **pending**. Record stable-period approval, archived object names and SHA-256,
archive verification, approved project IDs/deletion results, rotated key identifiers (never
values), removed secret names, drill bookmarks/timings/results, and recovery owner.

## Phase 4.4 — Final Google OAuth completion

This is the final phase after decommission. Its code PR targets `main` from
`migrate/stage-4-4.4-google-oauth`; do not enforce missing Google credentials during the earlier
GitHub-first rollout.

Use the owner's existing Google Cloud project. Present the exact project and these Web client
registration settings before making any app change:

| Environment | JavaScript origin                               | Authorized redirect URI                                                  |
| ----------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| Staging     | `https://tracera-staging.voltcrash.workers.dev` | `https://tracera-staging.voltcrash.workers.dev/api/auth/callback/google` |
| Production  | `https://tracera.voltcrash.com`                 | `https://tracera.voltcrash.com/api/auth/callback/google`                 |

Register the approved staging client and prepare the production pair while preserving its
unchanged callback. Obtain approval for required consent-screen, audience/test-user, publishing,
or existing production-client edits. Save complete Google pairs only in the appropriate
private mode-0600 files.

The phase's reviewable code change will:

- Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to production-required secret checks and
  `wrangler.production.json` `secrets.required` alongside GitHub.
- Preserve rejection of partial pairs and GitHub-only staging preparation.
- Retain complete Google configuration, token-discard, session, and OAuth callback tests.
- Update synthetic production validation inputs to include the now-required Google pair.
- Run Vite+ install/check/tests/build, both deployment dry runs, and browser tests before
  committing each change and opening the PR.

After that PR and credentials are reviewed, present exact approved commands for staging secret
upload/deploy, production environment-secret update, and the production release dispatch.
Google and GitHub sign-in, linked accounts, reload/session persistence, and sign-out must all
pass on both hosted origins before marking the overall migration complete.

Sign-off: **pending**. Record project/client identifiers, approved registration and consent
settings, final code PR, staging/production Worker versions and release, credential-pair
presence checks, and both-provider browser results. Do not record credential values.

### Staging Google enablement, 2026-10-13

The owner registered both Google Web clients with the origins and callbacks above and saved
complete pairs in the private staging and production files. `wrangler secret bulk` uploaded the
staging file, so staging now holds `BETTER_AUTH_SECRET`, both GitHub settings, and both Google
settings. `vp run web#deploy:staging` from this branch found no pending migrations and deployed
Worker version `be3bbc08-3c90-4abb-b19d-6ddbd1fd357a`.

| Check                       | Result                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| `/api/health`               | `ok`, database connected                                                |
| Google sign-in start        | Redirects to `accounts.google.com` with the staging Google callback     |
| Google client acceptance    | Google shows its account sign-in page, not a client or redirect error   |
| GitHub sign-in start        | Redirects to `github.com` with the staging GitHub callback              |
| Production settings dry run | `check:production` and the Wrangler dry run pass with the real settings |
| `PRODUCTION_WORKER_ENV`     | Updated in the GitHub `production` environment from the private file    |
