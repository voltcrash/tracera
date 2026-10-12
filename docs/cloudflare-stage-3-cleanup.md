# Stage 3 cleanup and release preparation

The owner requested on 2026-10-12 that the remaining repository implementation proceed before
the live-provider test. Phase 2.6 remains pending. Stage 4 deployments, cutover, decommission,
and hosted OAuth checks still require approval and their own sign-offs.

Stage 3 follows the accepted migration plan: remove legacy code, rewrite operations docs, then
replace CI and port the oxytype daily release workflow. Each phase has a separate stacked PR
and small validated commits. The Phase 3.1 PR also removes transitional CI calls to the deleted
tooling; the full replacement CI and release workflow land in Phase 3.3.

## Phase 3.1 — Legacy cleanup

PR: [#50](https://github.com/voltcrash/tracera/pull/50).

Worker authentication and D1 repositories are now the package defaults. D1 modules live in
`packages/db/src`, and AI storage-adapter tests use real D1. The Postgres runtime, schemas,
tests, migration directory, drivers, profile tooling, environment workspace, and deployment
configuration have been removed. The retired directory actually contained 30 SQL migrations,
seven schema snapshots, and its journal; the plan's count of 31 was corrected in this PR.

The Better Auth schema-generation CLI remains available through
`vp run @repo/db#db:generate:auth`. It writes an ignored review artifact at
`tmp/auth-schema.sqlite.ts`, rather than overwriting the reviewed application schema.
Schema generation uses `packages/db/auth-schema.config.ts`; the historical Stage 1 command
names were additive entries before this cleanup.

Validation: `vp install`, `vp check`, `vp test --run` (383 tests, 57 files, no skips),
`vp run check-types`, and `vp run build` pass. All seven fixture evaluation aliases and the
retrieval replay pass. The D1 suite passes 50 tests, migrations apply locally, Drizzle reports
no schema changes, auth schema generation succeeds, and all 10 browser tests pass.

A source audit of `apps`, `packages`, and `scripts`, excluding generated outputs and
historical documents, finds no retired framework/driver imports, database URL settings, or
profile settings. Dependency changes were made through Vite+; optional multi-driver peers
can still appear in its generated lockfile through Better Auth and Drizzle.

Local exit criteria pass. Final-head [CI validates the phase](https://github.com/voltcrash/tracera/actions/runs/38274270115) successfully at `bf48f5d`.
The real-provider Phase 2.6 criterion remains pending; no hosted changes were made here.

## Phase 3.2 — Operations and rollout documentation

PR: [#51](https://github.com/voltcrash/tracera/pull/51).

The README now describes the Worker/D1 architecture and a credential-free local fixture
quick start. `cloudflare-operations.md`, `staging-setup.md`, and `production-setup.md` replace
the retired profile guides. Provider overrides and all explicit live bounds remain documented,
along with isolated bindings, private settings, migrations, Workflow recovery, and Time Travel.
The historical Stage 1 record identifies its old additive command names.

`cloudflare-rollout.md` prepares each Stage 4 phase separately: live staging sign-off,
ordered cutover and rollback, verified archival/decommission and restore drill, then final
Google OAuth registration and enforcement. Every hosted gate remains pending, and commands
requiring approval have not been executed.

Validation: Vite+ install/check/unit tests (383 passing)/workspace types/build pass before
each commit. Local Markdown links resolve and documented Vite+ task names match the package
scripts. Current Wrangler help and primary Cloudflare documentation support recovery commands.
The production release workflow itself is implemented in Phase 3.3.
