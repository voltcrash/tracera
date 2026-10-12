# Production release helpers

Private workspace package supporting `.github/workflows/production-release.yml`. The date,
changelog, and release-planning patterns are ported from oxytype; product code and footer
release-history assets are omitted.

Run `vp run @repo/release#test:release` from the repository root. The package uses the shared
Vite+ installation so package and root test runs share one runner instance.

`version.js` formats the execution date in UTC as `vYY.MM.DD`. `daily-changelog.js` groups
Conventional Commit subjects into Features, Improvements, Fixes, and Other changes, escaping
Markdown and linking commits/PRs. The planner reads the actual Git graph and excludes merge
commits regardless of their subject.

`prepareProductionRelease` checks that checkout HEAD matches the workflow SHA. It considers
only completed production releases carrying the Tracera marker, refuses rewritten history or
a newer dated release, skips unchanged snapshots, and rejects date tags pointing to another
commit. A completed same-day release skips only when its tag matches HEAD; a matching tag
without a completed release permits retrying publication through the deployment pipeline.
The first scheduled release covers the preceding UTC day; the first manual release covers
the execution day. Subsequent releases include changes since the last successful release,
including old-authored branch commits merged later.

`writeProductionWorkerEnv` requires the Cloudflare token and complete Worker settings input,
writes mode `0600`, and refuses to replace an existing private file. The workflow always
removes that file. It installs, validates/builds/dry-runs, migrates D1, deploys with the planned
version, then calls `publishProductionRelease` for that exact SHA. Failure before publication
prevents a release, and publication failure still cleans credentials. It never resets or
bootstraps D1.

Tests use temporary real Git repositories, mocked GitHub release APIs, and execution of the
actual workflow scripts with a local Vite+ command stub. They verify no-change skips, ordering,
private file permissions, injected failures, collision guards, and cleanup without hosted
mutation or provider calls. Actual Worker bundles are validated separately by both CI dry runs.

See [production setup](../../docs/production-setup.md) and the
[rollout runbook](../../docs/cloudflare-rollout.md) for the owner-approved first deployment.
