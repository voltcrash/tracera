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

The tested source revision is
[`122ad67`](https://github.com/voltcrash/tracera/tree/122ad67e15d892fa8cbfda9f6642ec5ceca8716a).
It contains seven spike commits on top of Phase 0.1; use this snapshot to reproduce the
recorded results if the throwaway branch later changes.

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
`2026-07-30`, which its bundled workerd supports. Unit tests cover that supported date;
the Start app probes additionally exercise the newer date through Wrangler's runtime.

## Reproduce the spike

Use an isolated worktree of the throwaway branch. Commands below run from its repository
root; the main app and root `dev` script still use Next.js.

```sh
vp install
cp apps/cloudflare-spike/.dev.vars.example apps/cloudflare-spike/.dev.vars
vp run --filter cloudflare-spike cf-typegen
vp check --fix
vp run --filter cloudflare-spike db:migrate
vp run --filter cloudflare-spike dev --host 127.0.0.1
```

The ignored local secrets file contains only `MODE=dev` and a fixed local-only auth secret
from the example. It has no provider credentials. `.wrangler`, real `.dev.vars` variants,
and `dist` are ignored. The all-zero D1 ID in this throwaway config is for local use only.
Do not deploy it or use it as a hosted resource ID.

In a second terminal, build and start preview:

```sh
vp run --filter cloudflare-spike build
vp run --filter cloudflare-spike preview --host 127.0.0.1 --port 3001
```

The runtime probe scripts expect the dev server on port 3000 and CSP also checks preview on 3001. Stop conflicting servers or use these exact ports when reproducing the scripts.

## SSR, HMR, and Tailwind

The app config uses `defineConfig` from `vite-plus`, then plugins in this order:
`cloudflare({ viteEnvironment: { name: "ssr" } })`, `tanstackStart()`, `react()`, and
`tailwindcss()`. `vp dev`, `vp build`, and `vp preview` all succeeded with the current Vite+
core. The preview runs the built Worker through workerd.

Browser evidence from the local app:

- The SSR page rendered its heading and interactive counter in dev and built preview.
- Tailwind v4's `@import "tailwindcss"` produced the expected dark page; the computed
  background was `oklch(0.129 0.042 264.695)`.
- Clicking the counter changed it from 0 to 1.
- Editing the route's SSR text updated the page through HMR. The counter remained 1 and
  a marker placed on `window` remained present, proving there was no full-page reload.
- No CSP violation was observed during that HMR update.

Later browser automation calls lost their connection. The initial SSR, interactivity,
Tailwind, and HMR observations completed before that failure. Auth cookie verification
below uses real HTTP requests to the running Start app rather than claiming a completed
auth UI browser run.
An extension-enabled fallback browser also emitted a React hydration warning for injected
Dark Reader attributes. Use a browser without extensions when reproducing the UI probe.

## Generated files and type-aware checks

The Start plugin generated `src/routeTree.gen.ts`, including `/api/probe` when the probe
server route was added. Router generation uses `quoteStyle: "double"` and `semicolons: true`
to match repository formatting. `wrangler types` generated `worker-configuration.d.ts` with
the D1 and Workflow bindings and named Workflow entrypoint.

`vp check --fix` formatted the initial generated binding types, then plain `vp check` passed
with formatting, lint, type-aware lint, and type checking enabled. The app's tsconfig includes
`*.config.ts`, so the Vite and schema-generation configs are checked too. Generated files
were not excluded to make checks pass.

The final spike check covers 282 formatted files and 228 lint/type-checked files. The
unmodified docs-PR toolchain also passes its own checks; the spike's dependency upgrades
remain isolated from the migration PRs.

## Compatibility findings and fixes

- Adding an existing catalog entry did not update its resolved Vite core.
  `vp update -w vite vite-plus --latest` updated the actual core alias and root toolchain to current stable
  versions. `vp toolchain` confirmed Vite 8.3.3 and Vitest 5.0.3.
- workerd needs its install script allowed. The spike preserves the existing workspace
  `allowBuilds` choices and adds `workerd: true`; it does not replace those choices with
  unresolved entries reported by a package-manager prompt.
- Global Next.js lint rules treated Start's document `<head>` as Next code. The spike scopes
  the Next.js plugin to `apps/web/**/*.{ts,tsx}` while retaining general React, accessibility,
  TypeScript, type-aware, and type checks for Start. Existing Next code keeps its checks.
- Current Better Auth uses the separate `@better-auth/drizzle-adapter` package and the
  `auth` CLI for schema generation. The cookie plugin is last in the auth plugin list.
- Current Start needs its CSRF middleware retained when specifying request middleware. The
  spike explicitly installs `createCsrfMiddleware` for server functions.
- `vp node` worked through the global CLI but was unavailable in the local package-script
  wrapper. Runtime scripts use `node scripts/…` inside `vp run`, following existing repo
  script patterns and the managed Node LTS runtime.

`vp env doctor` completed successfully. No checks were bypassed, tests removed, or
dependencies downgraded to resolve these findings.

## Custom Worker entrypoint

`src/server.ts` exports `AnalysisWorkflow extends WorkflowEntrypoint` and a default handler
with both Start's `fetch` and a `scheduled` handler. Wrangler names the Workflow class in
the `ANALYSIS_WORKFLOW` binding. The Workflow step inserts a `workflow` row into local D1
and returns the synthetic run ID with `runtime: "workerd"`.

`POST /api/probe` creates an instance; `GET /api/probe?id=…` returns its status. Both routes
require `MODE=dev` and a loopback origin. A real local instance reached `complete` and
returned the expected output. Invoking `/cdn-cgi/local/scheduled?cron=17+*+*+*+*` returned
HTTP 200 and inserted a separate `scheduled` row.

Repeat the HTTP checks with the dev server running:

```sh
vp run --filter cloudflare-spike test:workflow
vp exec --filter cloudflare-spike wrangler d1 execute tracera-stage-0-spike --local --command 'SELECT kind, count(*) AS total FROM spike_events GROUP BY kind' --json
```

The D1 query confirmed both kinds persisted. Repeated probes add rows, so totals increase.
`wrangler deploy --dry-run` also recognized the custom Workflow class and D1 binding in the
built artifact; no remote deployment was made.

## D1, Drizzle, and Better Auth

The spike uses `drizzle-orm/d1` and `drizzleAdapter(database, { provider: "sqlite", schema })`.
The Better Auth CLI generated the sqlite auth schema; Drizzle Kit generated a real SQL
migration. Local Wrangler migration application succeeded for both the event table and auth
tables.

Schema generation commands, run from `apps/cloudflare-spike` on the throwaway branch:

```sh
vp dlx auth@latest generate --config ./auth-schema.config.ts --output ./src/server/schema.ts --yes
vp exec drizzle-kit generate
```

The test helper follows oxytype: instantiate Miniflare, get its D1 binding, read real SQL
migrations in filename order, split on `--> statement-breakpoint`, apply statements with
`database.batch()`, and dispose the runtime after the suite. No Postgres, Docker, pool
replacement, or alternate Vitest runner is needed for this new test.

The auth test creates a user and session through one Better Auth instance, retrieves that
session and user through a fresh instance, then deletes the session and verifies it is absent.
It passes inside Vite+'s bundled Vitest with the stable Miniflare dependency.

## Start auth cookies

`tanstackStartCookies()` is the last Better Auth plugin. The local fixture server functions
call Better Auth's sign-up, session, and sign-out APIs. They require both `MODE=dev` and a
loopback origin; the dev auth URL derives from that request origin.

`test:runtime` fetches the transformed Start server-function module, resolves the real RPC
IDs, and calls those RPC endpoints over HTTP against the running workerd dev server. It
keeps the cookie jar in memory and prints only boolean evidence:

- Sign-up returns HTTP 200 and sends `tracera-spike.session_token` through Start's response.
- The cookie is HttpOnly.
- Two subsequent server-function requests see the authenticated session persisted in D1.
- Sign-out sends a cookie with `Max-Age=0`.
- A later request sees the session as absent.

```sh
vp run --filter cloudflare-spike test:runtime
```

This proves the sqlite adapter and Start cookie integration together. It does not test
Google or GitHub OAuth; their staging applications belong to Phase 0.3. No session tokens or
real secrets are recorded in these notes.

## CSP nonces

The Worker fetch wrapper generates a random 18-byte nonce for every request and overwrites
its internal request header before calling Start. The router obtains the server nonce
through an isomorphic function and passes it as `ssr.nonce`. Client code reads Start's nonce
meta element. The response's CSP permits the same nonce and the response uses
`Cache-Control: private, no-store`.

Dev and built preview each returned three script elements, including two inline scripts.
All three had the response CSP's nonce. Two dev requests and one preview request had three
distinct nonces. Supplying a fake nonce in the request header did not affect the generated
nonce. The counter and HMR browser observations also succeeded with this CSP enabled.

```sh
vp run --filter cloudflare-spike test:csp
```

The script checks both ports, matching inline-script nonces, nonce uniqueness, overwriting
untrusted input, and cache headers. The spike's development policy permits WebSockets for
HMR and inline styles; final application policy and streaming integration remain Stage 2
work and must preserve the nonce behavior.

## Configured AI provider probe

The owner answered **none** when asked for the configured provider/model names needed for
the Phase 0.2 staging probe. There are therefore zero configured provider/model pairs to
probe in this phase. No provider key was requested, read, copied, or committed, and no
provider call or staging deployment was performed.

The repository still has Gemini, OpenAI, Anthropic, OpenRouter, and OpenAI-compatible
adapters. Adapter availability does not establish a configured platform provider. D5 still
retains those adapters and D14 still requires the provider resolver.

Before enabling any live provider, repeat the plan's structured-output probe from a step
in a deployed staging Worker using that actual provider and model. Keep credentials in the
private secrets file and request approval for the exact secret/deploy commands. Local
stubbed tests cannot establish whether a provider accepts Cloudflare network traffic.

## Validation and Phase 0.2 exit criteria

Each spike commit ran `vp install`, `vp check`, and `vp test` before commit. Relevant app
tasks were also run as they were introduced. Final validation:

| Check                              | Result and evidence                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `vp install`                       | Pass; lockfile and install scripts accepted                                                 |
| `vp check`                         | Pass; generated files and type-aware checks included                                        |
| `vp test` on spike branch          | 188 passed; 10 pre-existing Postgres tests skipped without their database environment       |
| `vp test` on documentation branch  | 187 passed; the same 10 pre-existing skips                                                  |
| `cf-typegen`, local `db:migrate`   | Pass; real bindings and sqlite migrations                                                   |
| `build`, `preview`                 | Pass; built Worker serves SSR in workerd                                                    |
| `deploy:dry-run`                   | Pass; Worker, D1, and Workflow artifact inspected locally                                   |
| `test:runtime`                     | Pass; persisted HttpOnly auth session and sign-out through real Start RPCs                  |
| `test:workflow`                    | Pass; complete Workflow and HTTP 200 scheduled invocation, with both D1 row kinds confirmed |
| `test:csp`                         | Pass; matching script nonces and unique request nonces in dev and preview                   |
| SSR/HMR and Tailwind browser probe | Pass; counter and window marker preserved across HMR                                        |
| Deployed configured-provider calls | Not applicable; owner confirmed no configured provider/model pairs                          |

The existing Postgres skips were present before this work; no test was removed or disabled.
The final spike has 28 passing test files and two pre-existing skipped files. This PR lands
only documentation, so it validates with the existing baseline toolchain and suite.

Written notes and a **GO** decision satisfy Phase 0.2's exit criteria for the confirmed
empty provider configuration. This does not complete Stage 0. Phase 0.3 was initially
blocked on R2; the [resource notes](cloudflare-stage-0-resources.md) record its resolution
and remaining requirements.

## Initial Phase 0.3 blocker and next-stage handoff

Before Phase 0.3 provisioning, read-only Wrangler inventory confirmed account `eb2679ce4f23ae7db4e6c4e3fcf8c3c1`. No Tracera
D1 databases or Workflows were present. Listing R2 buckets failed with Cloudflare error
10042: `Please enable R2 through the Cloudflare Dashboard.` Resource setup stopped there;
no resources, OAuth apps, auth secrets, or CI token were created.

R2 replaces the filesystem blob store for captured pages, screenshots, and large payloads,
and holds the final Neon dump before retirement. D1 holds structured records and blob
references. The plan requires separate `tracera-staging-blobs` and
`tracera-production-blobs` buckets behind the `BLOBS` binding. Local Miniflare work does not
require hosted R2 activation.

The owner activated R2 in the
[account Dashboard](https://dash.cloudflare.com/eb2679ce4f23ae7db4e6c4e3fcf8c3c1/r2)
on 2026-10-11; the bucket list subsequently succeeded. Wrangler has no R2 activation
command. Phase 0.3 then created both environments' resources using six explicitly approved
commands, including the Worker deployments that create Workflows. It also generated new
auth secrets in private local files. The [resource notes](cloudflare-stage-0-resources.md)
record the actual IDs and evidence. After initially deferring both staging OAuth apps
and the CI token, the owner completed GitHub staging OAuth and the CI token on
2026-10-12. Their credentials are in private mode-0600 files; the CI token verifies as
active and the intended resource inventory checks pass. Google staging OAuth remains
deferred, so Phase 0.3 is still incomplete. Production has no public bootstrap route;
the custom-domain cutover stays in Stage 4.

Complete Phase 0.3 and its separate PR before advancing beyond Stage 0. Stage 1 should use
the validated Vite+/workerd patterns, preserve the existing provider adapters, implement
the planned Worker-safe fetch and R2 blob store, and keep the resolver seam from D14. Stage
2 must carry forward the generated-file checks, scoped Next lint rules during transition,
real D1 migrations, Start cookie plugin ordering, and CSP nonce behavior. Recheck current
stable dependency versions at implementation time and run the deployed provider probe if
any live configuration is added.
