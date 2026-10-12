# Cloudflare rollout runbook

This is reviewable preparation for Stage 4, not a record of completed hosted work. Follow the
[migration plan](cloudflare-migration-plan.md) in phase order. The owner deferred the Phase 2.6
live-provider test until repository implementation is finished. Deployments, secret uploads,
DNS/OAuth changes, and decommission require approval of concrete actions before execution.

| Gate                          | Status                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------- |
| Phase 2.6 local live analysis | Pending owner credentials, explicit bounds, and live result                       |
| Phase 4.1 staging soak        | Pending approved secrets/deploy and signed live checks                            |
| Phase 4.2 production cutover  | Pending staging sign-off and approved cutover batch                               |
| Phase 4.3 decommission        | Pending agreed stable period, archive, deletion approvals, restore drill          |
| Phase 4.4 Google OAuth        | Pending final registration/credential approval, code PR, deploy, browser sign-off |

Record dates, reviewers, commit/Worker versions, run IDs, and outcomes beneath each gate.
Keep keys, OAuth secrets, cookies, private inputs, and logs containing private data outside Git.
Commands using `RUN_ID`, `BOOKMARK`, or private paths are templates; resolve them before
presenting an exact approval batch. The following commands have not been executed here.

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
evaluator currently rejects live mode until human-gold, authorization, and connector
prerequisites are supplied; fixture metrics cannot close this gate.

Sign-off: **pending**. Record reviewer, UTC window, model names, approved bounds, input types,
run/instance IDs, verdict/evidence checks, observed usage, and any unresolved failures.

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

Before decommission, rollback removes the Worker custom domain and restores the saved Vercel
DNS record and Git integration. Review and approve the exact rollback actions first. Old data
remains in Neon; Cloudflare-era accounts/history stay in D1 and are not imported back. Record
this limitation and the agreed rollback window before cutover.

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
