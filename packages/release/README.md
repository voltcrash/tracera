# Production deployment helpers

Private workspace package supporting `.github/workflows/production-release.yml`.
Run `vp run @repo/release#test:release` from the repository root.

The **Production deployment** workflow runs after **CI** succeeds for a push to `main`.
It deploys the exact CI snapshot only while that snapshot remains current `main` at both
eligibility checks. Superseded candidates skip production mutations. Failed, cancelled, fork and
pull-request runs cannot deploy. Manual dispatch from `main` supports same-day retries and
redeploying an unchanged commit. It creates no GitHub release, tag, changelog or package-version edit.

`production-validation.js` requires the latest main-push CI result for that exact SHA to be
completed successfully before credentials are prepared, and again immediately before migrations.
`productionEligibility` also compares the candidate with the current branch head. Release policy
is checked out from the workflow's SHA first, so an older candidate cannot replace that gate;
the exact eligible candidate is checked out before building. Missing, pending, failed and cancelled
CI blocks deployment. GitHub token permissions remain Contents and Actions read only; neither
checkout persists credentials. Production deployments remain serialized with `queue: max`, so a
late event does not replace an already-pending candidate.

Superseded candidates mark the job unsuccessful so GitHub does not record a successful
production environment deployment for an upload that was skipped. The summary distinguishes
this expected supersession from preparation, migration, or upload failures.

`production-settings.js` writes mode `0600`, refuses to replace an existing private file, and
requires both the Cloudflare token and complete Worker settings. Cleanup runs after success or
failure. Tests execute the actual workflow scripts with mocked GitHub APIs and local command
stubs, covering exact-SHA validation, same-day retries, unchanged commits, task failures and cleanup.

`production-state.js` derives the release outcome from step conclusions: `blocked`, `superseded`,
`preflight_incomplete`, `migration_incomplete`, `deployment_incomplete`, or `deployed`. The always-run
summary records the SHA and recovery guidance. After migration starts, the serialized candidate
continues to upload even if main advances. Migration and upload are separate operations: failures
require inspection and a forward retry, never an automatic database or Worker rollback.

One fresh production build creates the Worker and client with a `SHA-run-attempt` build ID.
`apps/web/scripts/production-artifact.ts` seals their file hashes outside the public client tree.
Checks and dry-runs verify that artifact rather than rebuild it. Production D1 migrations run
`PRAGMA optimize`; the deployment command enables and verifies read replication before upload.
Dry-runs do not migrate, optimize or change replica settings.

See [production setup](../../docs/production-setup.md) for configuration and deployment commands.
