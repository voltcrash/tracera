# Tracera web

The whole of Tracera: a TanStack Start app that runs on one Cloudflare Worker,
with D1, R2 and Workflows bound in `wrangler.jsonc` (staging, used locally) and
`wrangler.production.json` (production). See the
[migration plan](../../docs/cloudflare-migration-plan.md) for the target design.

From the repository root:

```sh
vp install
cp apps/web/.dev.vars.example apps/web/.dev.vars
vp run db:migrate
vp run dev
```

`vp run dev` serves the app from workerd with this worktree's local D1, R2 and
Workflows in `apps/web/.wrangler/state`; no Cloudflare login is needed. Vite
prefers port 3000 and moves to the next free port. `vp run dev:live` switches
to live analysis with the provider settings in `.dev.vars`.

## Structure

- `src/server.ts` is the Worker entry: Start's fetch handler, the cron hook and
  the `AnalysisWorkflow` class.
- `src/start.ts` and `src/router.tsx` configure Start and its router;
  `src/routes` holds file routes, and `src/routeTree.gen.ts` is generated.
- `src/server` holds server-only code; `src/server/env.ts` validates bindings and
  vars.
- `scripts/check-production.ts` validates production inputs before deploys.
- `worker-configuration.d.ts` is generated with `vp run cf-typegen`.
