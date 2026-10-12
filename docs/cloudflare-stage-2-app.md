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

## Phase 2.4 — Server layer replacing Hono

Result: **PASS** locally, 2026-10-12.

| Hono                                         | Start                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `requestIdMiddleware`, `onError`             | `securityMiddleware`: request ID, JSON error envelope; `serverFunctionErrors` for server functions                        |
| Security headers, CSP, `private, no-store`   | `securedResponse` in the same middleware, with the per-request nonce                                                      |
| `cors()`                                     | Removed; pages and API share one origin                                                                                   |
| `authenticatedUser` with its `WeakMap` cache | `authMiddleware` reading the D1 session once per call                                                                     |
| `configureDatabase`                          | D1 repositories from `env.DB` and `env.BLOBS`                                                                             |
| `GET /api/tracera/`                          | Removed                                                                                                                   |
| `GET /auth/me`                               | `getMe`                                                                                                                   |
| `GET /health`                                | `/api/health`                                                                                                             |
| `POST /analyze`                              | `startAnalysis`: one D1 admission batch, run row, Workflow instance; returns `{ runId, status }` or a typed control error |
| `GET /runs`, `GET /runs/:id`, cancel         | `listRuns`, `getRun` (also the `/run/$id` loader), `cancelRun`                                                            |
| `GET /runs/:id/events`                       | `/api/runs/$id/events`, same SSE format                                                                                   |
| Evidence                                     | `/api/runs/$id/evidence/$snapshotId`                                                                                      |

- The 7.1 MB body limit is in `startAnalysis`'s input validator. Validation errors use
  `ClientInputError` so their messages survive the generic error mapping.
- Admission and spend run on the D1 repositories. Admission passes only its limits, because
  D1 rejects the fractional spend settings the Postgres path ignored. Client IPs come from
  `cf-connecting-ip` first.
- The policy reads `MODE` and `ANALYSIS_MODE`; fixture analysis needs `MODE=dev` (D9).
- The workspace rail calls `listRuns`, the run page streams progress from the SSE route and
  cancels through `cancelRun`, and the home page navigates to `/run/$id` after
  `startAnalysis`. That navigation was listed under Phase 2.5 and moved here with the new
  response shape.
- The Hono app, its tests and the `hono` dependency are gone. Phase 3.1 listed this removal;
  it happened here once nothing imported Hono.

Until Phase 2.5 implements the Workflow, started runs stay queued and their admission
leases stay held until they expire, so the second concurrent start per user returns the
concurrency limit. The Postgres executor in `analysis-runtime.ts` is unused until then.

### Exit criteria

Ported tests invoke the server function cores and route handlers against Miniflare D1 and R2:
`analysis-api.server.test.ts` (start for text, link and image; validation; disabled
analysis; idempotency; start failure and replay; history; ownership; cancellation),
`api-routes.test.ts` (SSE, evidence, health), `error-handling.test.ts`,
`response-policy.test.ts`, `analysis-controls.test.ts`, `analysis-policy.test.ts`,
`analysis-functions.test.ts` and `route-guards.d1.test.ts`. All pass.

In the browser under `vp dev`, starting the example claim opens `/run/$id` with streamed
progress, the rail lists the queued trace, cancellation streams back as canceled, and pages
load under the new CSP without violations.

Validation: `vp install`, a Worker build, `vp check` and `vp test --run` pass before each
commit. The production client bundle contains no Drizzle, `node:crypto` or
`cloudflare:workers` code.

## Phase 2.5 — Analysis on Workflows

Result: **PASS** locally, 2026-10-12. PR: [#46](https://github.com/voltcrash/tracera/pull/46).

- The exported `AnalysisWorkflow` now runs the real focused engine. `analyze` retries twice,
  with an attempt timeout equal to the persisted run budget. Successful engine stages replay
  their D1 checkpoints. `finalize` reads an R2 report reference and publishes one report;
  `release` stores the idempotent response and frees the admission lease. Provider calls reserve
  and settle spend against D1 individually; interrupted reservations remain for Phase 2.7.
- Workflow params contain run, owner, and admission IDs. Step results contain status, fencing
  identity, and an R2 reference, keeping reports, uploads, and provider keys out of Workflow
  state. Providers resolve inside the analysis step; hosted fixture selection is rejected.
- Screenshots always go to R2 before instance creation; other inputs use the D1 payload size
  threshold. Image data URIs survive input parsing. Admission IDs are also stored with the
  scoped run input so cancellation and maintenance can finish cleanup independently.
- Fixture mode composes the scripted claim generator, empty discovery, and fixed page/OCR
  documents from `packages/ai/scripts/support`. Text uses its actual offline extraction. All
  eight engine stages execute; absent evidence leaves published claims unverified, a null score,
  and a terminal `partial` report. Production analysis semantics and contracts are unchanged.
- Cancellation is checked at checkpoint boundaries. The server function schedules a five-second
  grace period with `waitUntil`, then terminates an unfinished instance, acknowledges the scoped
  flag, and releases admission. Failed termination preserves the running state for later cleanup.
- The old request executor, queue lease acquisition and renewal, cancellation polling, and
  process-based worker IDs are removed. Superseded attempts are closed as failed. Admission
  leases cover all bounded analysis and settlement retries without renewal timers.

### Exit criteria

| Criterion                     | Result and evidence                                                                                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture completes in `vp dev` | Pass; browser sign-in as Ada, example claim opens `/run/$id`, streams progress, and shows the real unverified report. Text/link/image D1 tests reach all eight stages.                                                                         |
| Cancellation                  | Pass; workerd test terminates a blocked real Workflow, checks native status `terminated`, D1 status `canceled`, and no held admission lease. Grace-period tests cover ownership and termination failure.                                       |
| Injected failure resumes      | Pass; workerd injects failure after the normalization checkpoint, retries to attempt 2, reaches eight checkpoints, and releases admission. Additional D1 tests prove normalization/generation are not repeated and finalization is idempotent. |

Validation: `vp install`, `vp check`, `vp test --run` (387 passed; 10 existing Postgres cases
skipped), `vp run check-types`, `vp run build`, and the staging deployment dry run pass.
Evidence: `fixture-analysis.test.ts`, `analysis-workflow.test.ts`,
`analysis-workflow.workerd.test.ts`, and `analysis-cancellation.test.ts`.

No hosted resources, secrets, deployments, DNS, or OAuth apps changed. Browser reload testing
also found a timezone hydration mismatch in the report timestamp; Phase 2.8 will fix and cover it.
The owner deferred the live-provider validation until credentials can be configured; Phase 2.6
will record that gate as pending while subsequent Stage 2 implementation proceeds.

## Phase 2.6 — Retrieval and evidence on Workers

Result: **implementation and offline validation PASS; live exit criterion PENDING**,
2026-10-12. PR: [#47](https://github.com/voltcrash/tracera/pull/47).

- Google News RSS, GDELT, Google Fact Check, and NewsAPI retain their discovery transports
  through Worker-safe `safeFetch`. Fact Check and NewsAPI are enabled only when their optional
  keys exist. Discovery hints remain candidates, and source outages remain explicit failures.
- `evidence-search.workerd.test.ts` exercises all four sources, credential transport, omitted
  optional sources, outage behavior, and real HTTP document acquisition with raw bytes
  round-tripping through R2. The existing workerd provider suites continue covering all five
  provider adapters with stubbed upstreams.
- Production input validation now enforces the same explicit budget and spend bounds as the
  runtime policy, including non-secret Wrangler vars. Previously it checked the provider only.
  Both secrets examples list the settings required for live mode, without choosing production
  budgets or provider models.
- Browser Rendering remains deferred until staging shows acquisition gaps, as planned.

Validation: `vp install`, `vp check`, `vp test --run` (404 passed; 10 existing Postgres cases
skipped), `vp run check-types`, `vp run build`, and the production deployment dry run with
synthetic mode-0600 settings pass. The synthetic file was removed after the check.

The owner deferred provider credentials on 2026-10-12 and asked implementation to continue.
`dev:live` has therefore not been checked against a real provider. Before closing this gate,
configure the chosen provider/model/key and explicit run/spend bounds in `.dev.vars`, then run
`vp run dev:live` and complete an analysis. The hosted provider-network probe recorded in
Stage 0 remains open and requires approval before deploying or changing hosted secrets.
No hosted resources, secrets, deployments, DNS, or OAuth apps changed.

## Phase 2.7 — Scheduled maintenance

Result: **PASS** locally, 2026-10-12. PR: [#48](https://github.com/voltcrash/tracera/pull/48).

- The scheduled Worker handler reconciles errored or terminated instances, respects scoped
  owner cancellation and its grace period, and completes interrupted admission release for
  already-finalized reports. Native status outages leave runs active and do not block expiry
  cleanup. Paginated scans reach runs beyond the first 100 instances.
- One guarded D1 batch conservatively charges expired spend reservations at their estimate,
  updates the spend circuit, and purges expired idempotency keys, released/expired leases,
  old rate windows, expired sessions/verifications, and settled expired reservations. Concurrent
  calls do not double-charge; active reservations and records survive.
- Miniflare tests cover every expiry category, spend concurrency, Workflow failure, running and
  queued cancellation, pagination, status outages, and recovery after report finalization.

The real local scheduled endpoint returned `outcome: ok` and logged two expired leases and
two old rate windows purged, with zero Workflow status errors. Reproduce while `vp run dev`
is running:

```sh
curl --fail-with-body -X POST \
  'http://localhost:3000/cdn-cgi/local/explorer/api/local/scheduled?worker=tracera-staging' \
  -H 'Content-Type: application/json' --data '{"cron":"17 * * * *"}'
```

Validation: `vp install`, `vp check`, `vp test --run` (412 passed; 10 legacy Postgres cases
skipped), `vp run check-types`, and `vp run build` pass. Evidence:
`packages/db/test/d1/maintenance.test.ts`, `apps/web/test/maintenance.test.ts`, and the local
scheduled invocation above. No hosted resources or settings changed.

## Phase 2.8 — Browser tests

Result: **PASS** locally and in CI, 2026-10-12. PR:
[#49](https://github.com/voltcrash/tracera/pull/49).

- Playwright starts `vp dev` at `http://127.0.0.1:3000` with `--strictPort`, applies the real
  local D1 migrations, and removes its two synthetic identities and their analysis records
  through `wrangler d1 execute --local`. It creates a mode-0600 fixture `.dev.vars` only when
  the file is absent and validates existing settings without replacing them.
- Both identities use real Better Auth D1 sessions. The browser checks their cookies, persisted
  session rows, reloads, settings, sign-out, and the anonymous workspace redirect.
- Real local Workflows process pasted text, public links, screenshots through fixture OCR,
  and three selected claims. Missing evidence keeps the score null; screenshot authenticity
  stays explicitly unassessed. Saved D1 fixtures cover exact snapshot/excerpt downloads,
  report reloads, generic provider-failure messages, and cancellation through the server
  function and SSE. Native Workflow termination and admission release are covered separately
  by the Phase 2.5 workerd tests; the seeded browser cancellation case has no native instance.
- Browser testing fixed composer input loss and inert cancellation clicks before hydration, plus
  report/settings dates that differed between the server's UTC timezone and the browser's
  timezone. Localized dates now
  render after hydration with stable ISO fallback text. Reload checks run in `Asia/Kolkata`
  and assert no page errors. Failed and canceled runs now say "Analysis ended".
- CI runs `vp run test:browser` under the existing external-network denial wrapper after
  acquiring Chromium. The browser server and SQL helper set
  `CLOUDFLARE_CF_FETCH_ENABLED=false` and `WRANGLER_SEND_METRICS=false` so local tooling
  uses default request metadata and avoids telemetry network waits. A repeated CI run
  exposed these waits exhausting browser test deadlines; the fix retains the existing
  timeouts and all assertions. Docker and the old integration suites remain until Stage 3.

Validation: `vp install`, `vp check`, `vp test --run` (412 passed; 10 legacy Postgres unit cases
skipped), `vp run check-types`, `vp run build`, both targeted browser commands, and the full
browser command (10 passed) pass. [CI evidence](https://github.com/voltcrash/tracera/actions/runs/38259938772)
also passes its retained Postgres integration checks and the browser suites with external
networking denied. All eight stacked Stage 2 PRs are green.

Stage 2 implementation is ready for review. Phase 2.6's actual `dev:live` exit criterion remains
pending until the owner configures a provider/model/key and explicit run/spend bounds locally.
No hosted resources, secrets, deployments, DNS, or OAuth apps changed. Stage 3 removes the
remaining Postgres/environment tooling and replaces the transitional CI; the hosted provider
probe, staging rollout, and final Google OAuth work remain in their planned stages.
