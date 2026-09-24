# Local development

Tracera's local workflow uses a worktree-specific PostgreSQL/pgvector container, real
database-backed Better Auth sessions, and deterministic analysis fixtures. It needs no
production credentials, hosted database, social-auth provider, paid AI provider, Redis,
cloud storage, or local language model.

## Prerequisites

- Node.js 24 LTS and Vite+ (`vp`)
- a running Docker-compatible engine
- Chromium installed for the browser suites
  (`vp exec --filter web --fail-if-no-match -- playwright install chromium`)

Run `vp install` after checkout. The database image is the digest-pinned PostgreSQL 18.6
and pgvector 0.8.6 image documented in `docs/environment.md`; the lifecycle command pulls
it when it is absent.

## Daily workflow

```sh
vp run local:setup       # generate configuration, start PostgreSQL, migrate, health-check
vp run dev               # start the app on this worktree's generated loopback port
vp run local:down        # stop PostgreSQL without deleting development data
```

`local:setup` is idempotent: generated secrets remain unchanged, an existing database
volume is retained, and repeat migrations are a no-op. `local:up` starts and health-checks
an already configured worktree without migrating. Use `vp run env:diagnose:local` to see
the selected profile, role, and redacted target.

The generated web, development-database, and disposable-test ports come from the real
worktree path. Configuration lives under ignored `.tracera/environment/` with mode-0600
role files. Do not copy that directory between worktrees or place provider credentials in
the files or inherited shell environment.

## Tests and reset

```sh
vp check
vp test --run
vp run check-types
vp run build
vp run test:integration
```

`test:integration` starts and migrates the local database, then runs the empty-database
migration/privilege rehearsal, analysis storage integration, Better Auth browser smoke test,
and analysis fixture evaluator. The database suites create and
drop fresh databases in the disposable test cluster. Browser fixtures use the persistent
development database through the least-privileged runtime role and delete only their
reserved synthetic rows. If the command started the local container, it stops it afterward
without deleting its volume; a container that was already running remains running.

The migration rehearsal and analysis storage runner fail when provisioning fails, no tests
execute, or any integration test is skipped. Playwright likewise fails when its selected
test file executes no tests.

`vp run local:reset` is destructive only to the current worktree's labeled development
container and volume. It prints the resolved target, refuses arbitrary URLs or resource
names, recreates the database, and applies migrations. `local:down` is non-destructive.

## Roles and fixtures

The web process receives only `tracera_runtime` credentials. Bootstrap, migrator, and
test-provisioner access remain in separate processes; the exact grants are documented in
`docs/environment.md`. The two browser identities are `ada@tracera.local` and
`grace@tracera.local`. Analysis evaluation fixtures use scripted inputs and never fall back to a
live provider.

CI generates fresh synthetic secrets and has no step that imports repository secrets. It
downloads dependencies, the database image, and Chromium first, then applies a Linux
firewall deny rule while running unit and integration suites. Only loopback and the local
Docker bridge remain reachable during those suites.

Real OAuth callbacks and live-provider, human-gold, calibration, paid-evaluation,
production-migration, deployment, and release-approval work are separate and require
their own authorization. Fixture success must not be treated as real-world accuracy or
release evidence.
