# Local development and testing plan

Status: L01–L04 are authorized. L05–L06 are recorded here for sequencing only and are not authorized by this document.

## Objective and boundaries

Tracera development and automated tests will run without production credentials, production databases, hosted authentication, or paid AI calls. Local execution will use PostgreSQL with pgvector, real Better Auth sessions, and deterministic acquisition and AI fixtures. Production behavior, tenant isolation, SSRF controls, frozen Core v2 contracts, and the historical Core Task 03 blocker must remain intact.

Each task is delivered as one stacked pull request. A successor starts only after explicit approval. If its predecessor is open, it branches from the predecessor tip and targets that branch; after merges, the branch and base are reconstructed from the actual merge history. No task merges or deploys its own PR.

## L01 — Environment isolation

Branch: `local-dev/l01-environment-isolation`; base: `main`.

- Replace implicit root `.env` loading with explicit `local`, `test`, and `deployed` profiles independent of `NODE_ENV`.
- Split configuration roles into runtime, migration, test provisioning, and analysis. Reject cross-role database credentials.
- Generate ignored worktree-specific files, strong local secrets, database names, and ports without reading legacy secrets.
- Give generated files authority only through the profile launcher. Reject inherited managed variables, duplicate selected-file keys, legacy root environment files, and post-launch changes to sealed settings.
- Validate local/test database URLs as loopback-only, worktree-bound targets with the expected role before a pool or migration command can connect.
- Reject external auth, AI, and retrieval credentials/endpoints in local/test profiles. Guard migration and AI script entry points.
- Emit only redacted profile, role, and database-target diagnostics. Document safe retirement of root `.env` files.
- Prove failure behavior with deterministic configuration tests. PostgreSQL, local auth, and offline analysis remain explicitly unfinished.

## L02 — Local PostgreSQL and compatibility

Branch: `local-dev/l02-postgres`; base: the completed L01 tip unless L01 has merged.

- Add a containerized, loopback-only current PostgreSQL/pgvector service with worktree-specific names, ports, persistent development storage, health checks, and isolated test storage.
- Create separate bootstrap, migrator, runtime, and test-cleanup privileges. Keep owner credentials out of the web process.
- Add an explicit connection factory selecting a standard local TCP driver or the retained Neon deployment transport.
- Implement safe start, stop, health, bootstrap, migrate, and reset commands; every destructive command must resolve and verify its generated worktree target.
- Rehearse the full immutable migration history on an empty database twice, audit journal consistency and grants, and add only necessary privilege migrations.
- Verify pgvector, full-text search, transactions, runtime DML, denied runtime DDL, persistence after restart, and cross-worktree/reset isolation.

## L03 — Core Task 03 PostgreSQL validation

Branch: `local-dev/l03-core-storage-validation`; base: completed L02 tip unless predecessors have merged.

- Provision a fresh per-run database, migrate it through real history, execute Core storage integration tests as runtime, and clean it up only with the provisioning role.
- Make provisioning failure and zero integration tests hard failures.
- Exercise duplicate enqueue, retry, cancellation, stale-worker fencing, atomic completion, preserved report values, tenant isolation, concurrent workers, and transaction rollback.
- Run the suite twice from clean databases and append evidence to the original Core Task 03 handoff without rewriting its blocked history.
- Clear only the PostgreSQL storage-validation blocker; human-gold, calibration, paid evaluation, and release gates remain separate.

## L04 — Fully local authentication

Branch: `local-dev/l04-local-auth`; base: completed L03 tip unless predecessors have merged.

- Reuse the existing development-login mechanism to create real database-backed Better Auth sessions for a fixed set of synthetic identities.
- Require an explicit local profile, development mode, loopback origin, and validated local database. Keep development login impossible in deployed profiles.
- Configure local trusted origins and cookie behavior deliberately, expose a clear local sign-in action, and disable unavailable social providers locally.
- Verify browser login, refresh/session retrieval, logout, session persistence, and two-user data isolation while preserving deployed OAuth security and token-storage behavior.

## L05 — Deterministic offline analysis

Branch: `local-dev/l05-offline-analysis`; base: completed L04 tip unless predecessors have merged.

- Add deterministic generation, image analysis, and 1024-dimensional embeddings behind existing provider boundaries.
- Add synthetic text, URL, and image acquisition/retrieval fixtures for success, inaccessible sources, conflicting evidence, missing fixtures, and provider failures.
- Audit every external path and prohibit live fallback in fixture mode. Unknown fixtures return an explicit unavailable result.
- Preserve real auth, database persistence, rate limits, idempotency, spend controls, tenant scope, and SSRF protections.
- Define local raw-blob storage needed by Core Task 04 only where current local flows require it, and label all fixture reports as synthetic.

## L06 — Workflow, CI, and readiness handoff

Branch: `local-dev/l06-workflow-ci`; base: completed L05 tip unless predecessors have merged.

- Finalize the root workflow for setup, up, development, integration tests, reset, and non-destructive shutdown.
- Run CI with disposable PostgreSQL and synthetic secrets only. Deny external networking for offline suites after dependencies and images are available.
- Document prerequisites, generated resources, ports, role permissions, fixtures, reset safety, and optional separately authorized live evaluation.
- Verify the documented workflow from a second clean worktree, including database integration, browser auth smoke coverage, Core fixtures, checks, tests, types, and build.
- Report all PR bases and merge order, Core Task 03 PostgreSQL status, and local readiness for Core Task 04. Leave every PR open and do not resume Core implementation.

## Validation and handoff contract

Every approved task runs `vp check`, `vp test --run`, `vp run check-types`, its task-specific checks, and `vp run build` when runtime/API/UI/integration behavior changes. A required integration command executing zero tests fails. Each `docs/local-development/handoffs/LNN.md` records the parent, exact commands and counts, real-versus-fixture evidence, configuration or migration instructions without secrets, limitations, blockers, and successor directions.
