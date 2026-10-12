# Stage 2 app on TanStack Start and Workers

Stage 2 follows the phase order and exit criteria in the
[accepted migration plan](cloudflare-migration-plan.md). Each phase is one pull request into
`migrate/cloudflare`, stacked on the previous phase. `main` and Vercel stay untouched.

## Phase 2.1 — Framework swap and the oxytype config model

Result: **PASS** locally, 2026-10-12.

- Vite+ and its Vite core moved to 1.1.0 (Vite 8.3.3, Vitest 5.0.3). TanStack Start
  1.168.61, TanStack Router 1.170.42, `@cloudflare/vite-plugin` 1.63.1,
  `@vitejs/plugin-react` 6.1.2, `@tailwindcss/vite` 4.3.3, Wrangler 4.149.0, Zod 4.6.6 and
  tsx were added with `vp add` at their latest stable releases.
- Next.js, `next.config.js`, `postcss.config.mjs`, `src/proxy.ts`, the App Router tree, the
  root `next` dev dependency and the Next agent notes are gone. The global stylesheet and
  fonts moved to `src/styles`, the icons to `public/`. The proxy's route-guard test left
  with it; Phases 2.2 and 2.4 add the Start guards and their tests. The workspace shell and
  auth provider depended on `next/navigation` and return with their pages in Phase 2.2.
- `safeFetch` uses only Web `fetch` with manual redirects. The pinned Node transport, its
  package condition and its test are removed as approved in Phase 1.1.
- Both Wrangler configs bind `DB`, `BLOBS`, `ANALYSIS_WORKFLOW`, the hourly cron and the
  section 3 vars, using the Phase 0.3 resources. Production disables workers.dev and preview
  URLs, claims `tracera.voltcrash.com` as a custom domain and requires its secrets.
- `src/server.ts` exports Start's fetch handler, a `scheduled` hook and a placeholder
  `AnalysisWorkflow`; `src/start.ts` keeps Start's CSRF middleware for server functions;
  `src/server/env.ts` validates bindings and vars with Zod without echoing values.
- The section 4 scripts exist at the root and in `apps/web`. `check:production` ports
  oxytype's production-inputs checks.

Plan amendments recorded in section 4: deploys pass the built `dist/server/wrangler.json`,
because Wrangler rebundles `src/server.ts` without Vite when given a source config;
`build:production` selects the production config through
`CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH`; and `dev:live` runs Vite's `live` mode because
`.dev.vars` always overrides config vars. The oxlint `nextjs` plugin left with Next.

CI drops the Next/Postgres browser auth suite from `test:integration` until Phase 2.8 ports
it, builds the Worker and dry-runs the staging deploy. `vercel.json` skips previews for
`migrate/**` branches, which can no longer build as Next.js.

### Exit criteria

| Criterion                          | Result and evidence                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `dev`                              | Pass; `vp run dev` serves the placeholder from workerd: mode `dev`, fixture analysis |
| Placeholder with local D1 migrated | Pass; `db:migrate` and `db:reset` apply both migrations; the page reports 2 applied  |
| `dev:live`                         | Pass; the same page reports live analysis                                            |
| `build`, `preview`                 | Pass; the built Worker serves the page and the local scheduled endpoint returns 200  |
| `wrangler deploy --dry-run`        | Pass for staging and, with synthetic secrets, `deploy:production-dry-run`            |

Validation: `vp install`, `vp check`, `vp test --run` (328 passed; the 10 existing Postgres
cases are skipped by the unit runner), `vp run check-types` and `vp run build` pass before
each commit. Local Docker is unavailable, so the Postgres integration suites run in hosted
CI. No hosted resource, secret, deployment, DNS record or OAuth app was changed.

Evidence: `apps/web/test/env.test.ts`, `production-inputs.test.ts` and the commands above.
