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

## Phase 2.2 — Pages, layout, and navigation

Result: **PASS** locally, 2026-10-12.

- Every Next page is a Start file route per appendix A: `/`, the pathless `_workspace`
  layout with `/home`, `/run/$id` and `/settings`, and the public `/auth/complete`,
  `/auth/error`, `/reset-password` and `/verify-email`. `next/link`, `next/navigation` and
  `next/image` became TanStack Router's `Link`, `useLocation`, `useNavigate`,
  `router.invalidate`, `Route.useSearch` and plain `img` elements.
- The root route's `head()` carries the title, description, Open Graph and Twitter cards,
  dark-reader lock and explicit icon links. `HeadContent` keeps one meta per name, so the
  two `theme-color` metas render directly. The theme bootstrap script carries a
  per-request nonce minted by the Worker entry; Phase 2.4 adds the CSP header that uses it.
- Geist loads from the local files through `@font-face`; Newsreader is self-hosted with
  `@fontsource-variable/newsreader` (D11). The 16 remaining `"use client"` directives are
  gone (the other nine left with the Next pages in Phase 2.1), and `components.json` sets
  `rsc: false` with the new CSS path.
- `getSession` reads Better Auth's D1 session. The `_workspace` layout's `beforeLoad` sends
  anonymous visitors to `/`, and `/` sends signed-in users to `/home`, replacing `proxy.ts`.
- `getSignInOptions` offers the dev identities locally, otherwise only providers with complete
  credential pairs, so hosted staging shows GitHub alone until Phase 4.4 (D17).
- The auth provider's client redirect after a session ends now exempts `/` and `/auth/error`;
  under Next it also redirected anonymous visitors away from the public error page.

Known gaps left for later phases: the account menu and trace history stay in their loading
states until Phase 2.3 serves `/api/auth/*` and Phase 2.4 replaces `/api/tracera/*`. The
Open Graph image `/og.png` is referenced by the metadata but has not been in the repository
since September; parity keeps the reference.

### Exit criteria

| Criterion                           | Result and evidence                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Every page renders under `vp dev`   | Pass; with a dev session minted in local D1, every route returns 200 or its redirect                                                    |
| Navigation parity                   | Pass; anonymous workspace requests redirect to `/`, signed-in `/` redirects to `/home`, both on the server and during client navigation |
| Sign-in offers configured providers | Pass; landing shows the dev identities locally; tests cover GitHub-only and both providers                                              |

Validation: `vp install`, a Worker build, `vp check` and `vp test --run` (344 passed; 10
existing Postgres cases skipped) pass before each commit. Evidence:
`apps/web/test/session.test.ts`, `route-guards.test.ts`, `sign-in-options.test.tsx` and
`nonce.test.ts`.

## Phase 2.3 — Auth endpoints

Result: **PASS** locally, 2026-10-12.

- `src/routes/api/auth/$.ts` answers GET and POST through `handleAuthRequest`, which runs
  Better Auth on D1 and keeps the Hono route's mapping of 5xx responses to the generic error
  body with a request ID. Configuration failures, which Hono's `onError` caught, return the
  same body.
- The dev identities list moved into the dev-login Better Auth plugin as
  `/api/auth/dev-identities`, behind the same mode, flag, loopback and origin checks.
  `authClient` is unchanged. The web app's Better Auth client moved from 1.7.3 to 1.7.7 to
  match the server.
- Browser testing exposed a Phase 2.2 defect: `session.ts` exported its D1 helpers next to
  its server functions, so the client bundle pulled in `@repo/db` and `node:crypto`. The
  helpers moved to `session.server.ts`; the fix is in PR #43, and the production client
  bundle no longer contains Drizzle or `node:crypto`.

### Exit criteria

| Criterion                                                      | Result and evidence                                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Local sign-in as `ada@tracera.local` and `grace@tracera.local` | Pass; in a browser under `vp dev`, each dev identity button lands on `/home` with its account in the menu |
| Persists across reloads                                        | Pass; full page loads of `/home` and `/settings` keep the session; settings lists linked accounts         |
| Signs out                                                      | Pass; the account menu's sign-out returns to `/`, `get-session` is null and `/home` redirects             |

Miniflare D1 tests repeat the flow for both identities: dev login sets the
`tracera.session_token` cookie and redirects to `/home`, two session reads return the user,
and sign-out expires the cookie and clears the session.

Validation: `vp install`, a Worker build, `vp check` and `vp test --run` (352 passed; 10
existing Postgres cases skipped) pass before each commit. Evidence:
`apps/web/test/auth-route.test.ts` and `packages/auth/test/dev-auth-bypass.d1.test.ts`.
