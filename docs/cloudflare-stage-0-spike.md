# Stage 0 toolchain spike

Date: 2026-10-11. Phase 0.2 result: **GO for the currently configured provider set (none)**.
The local framework, database, auth, Workflow, scheduled-handler, and CSP probes pass.
Cloudflare network compatibility with external AI providers remains unproven until a provider
is configured and the deployed staging probe is run.

This document is the mergeable output of Phase 0.2. The app, dependency upgrades, generated
types, migrations, and tests remain on the
[throwaway spike branch](https://github.com/voltcrash/tracera/tree/migrate/stage-0-0.2-toolchain-spike)
under `apps/cloudflare-spike`. Do not merge that branch. Product implementation starts in the
later stages of the [migration plan](cloudflare-migration-plan.md).

The spike follows oxytype's config, secrets-file, SQL migration, and Miniflare test patterns.
It does not copy oxytype's product code. No Cloudflare resource, secret, deployment, DNS
record, or OAuth application was created or changed for this spike.

## Versions tested

Dependencies were resolved with `vp add` and `vp update --latest` on the spike branch,
without downgrades or manual lockfile edits. Versions below describe the observation on the
spike date; resolve current stable releases again when implementing the migration.

| Tool or dependency                              | Version                  |
| ----------------------------------------------- | ------------------------ |
| Node.js, latest LTS                             | 24.21.0                  |
| pnpm through Vite+                              | 11.20.0                  |
| Vite+ / Vite core alias                         | 1.1.0 / 1.1.0            |
| Bundled Vite / Vitest                           | 8.3.3 / 5.0.3            |
| Bundled Rolldown / Oxlint / Oxfmt               | 1.2.12 / 1.87.0 / 0.72.0 |
| Cloudflare Vite plugin / Wrangler               | 1.63.1 / 4.149.0         |
| TanStack Start / React Router                   | 1.168.61 / 1.170.42      |
| React / React DOM                               | 19.3.0 / 19.3.0          |
| React Vite plugin                               | 6.1.2                    |
| Tailwind / Tailwind Vite plugin                 | 4.3.3 / 4.3.3            |
| Better Auth / Better Auth Drizzle adapter       | 1.7.7 / 1.7.7            |
| Drizzle ORM / Kit                               | 0.45.4 / 0.31.11         |
| Zod                                             | 4.6.5                    |
| Direct Miniflare test dependency, latest stable | 4.20260730.0             |

Miniflare's registry `latest` tag pointed at `5.20261006.1-alpha`; the direct test dependency
uses the newest stable release. Wrangler itself brings that alpha transitively. The app uses
compatibility date `2026-10-11` with `nodejs_compat`; the stable Miniflare unit-test helper uses
`2026-07-30`, which its bundled workerd supports. This is a test-runtime date difference,
not proof of identical compatibility flags across the two runtimes.
