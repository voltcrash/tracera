# Production deployment helpers

Private workspace package supporting `.github/workflows/production-release.yml`.
Run `vp run @repo/release#test:release` from the repository root.

The **Production deployment** workflow runs after **CI** succeeds for a push to `main`.
It deploys the exact CI snapshot, even if `main` has advanced. Failed, cancelled, fork and
pull-request runs cannot deploy. Manual dispatch from `main` supports same-day retries and
redeploying an unchanged commit. It creates no GitHub release, tag, changelog or package-version edit.

`production-validation.js` requires the latest main-push CI result for that exact SHA to be
completed successfully before credentials are prepared. Missing, pending, failed and cancelled
CI blocks deployment. GitHub token permissions are Contents and Actions read only; checkout
does not persist credentials. Production deployments remain serialized.

`production-settings.js` writes mode `0600`, refuses to replace an existing private file, and
requires both the Cloudflare token and complete Worker settings. Cleanup runs after success or
failure. Tests execute the actual workflow scripts with mocked GitHub APIs and local command
stubs, covering exact-SHA validation, same-day retries, unchanged commits, task failures and cleanup.

One fresh production build creates the Worker and client with a `SHA-run-attempt` build ID.
`apps/web/scripts/production-artifact.ts` seals their file hashes outside the public client tree.
Checks and dry-runs verify that artifact rather than rebuild it. Production D1 migrations run
`PRAGMA optimize`; the deployment command enables and verifies read replication before upload.
Dry-runs do not migrate, optimize or change replica settings.

The former date planner, version allocator, changelog generator and publication code have been
removed. Historical rollout records are retained as records rather than deployment policy.
See [production setup](../../docs/production-setup.md) for current commands and
[remaining differences from Oxytype](../../docs/production-workflow-comparison.md).
