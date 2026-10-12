# Cloudflare operations

Tracera runs one TanStack Start Worker with D1, private R2, Workflows, and hourly Cron.
Node.js 24 LTS is used for tooling; local requests execute in workerd. The default Wrangler
config targets staging, and production has its own config and resources.

## Local fixture development

From the repository root:

```sh
vp install
cp -n apps/web/.dev.vars.example apps/web/.dev.vars
chmod 600 apps/web/.dev.vars
vp run db:migrate
vp run dev
```

Open `http://localhost:3000`. The ignored private file is
`apps/web/.dev.vars`; keep an existing file when repeating setup. Its local settings are
`MODE=dev`, `ANALYSIS_MODE=fixture`, and `DEV_AUTH_BYPASS=true`, with the local-only auth
secret from the example. Fixture analysis and synthetic Ada/Grace sign-in need no hosted
credentials. OAuth providers appear only when their complete credential pairs are configured.
The bypass is restricted to development on a loopback origin and creates real D1 sessions.

Local D1, R2, and Workflow state live under `apps/web/.wrangler/state`, separately in each
worktree. No Cloudflare login is needed for local development. Stop the development server
before deleting local D1 with `vp run db:reset`; that command remigrates only local D1 and
leaves local R2 state in place.

For a fixed port, use `vp run dev --host 127.0.0.1 --port 3000 --strictPort`. Use another port
when running a second worktree. Browser tests require port 3000 to be available.

## Validation

```sh
vp check
vp test --run
vp run check-types
vp run build
vp exec --filter web --fail-if-no-match -- playwright install chromium
vp run test:browser
vp run evaluate:analysis-release:fixture
vp run evaluate:analysis-retrieval:replay
```

The unit suites use real Miniflare D1/R2 and native Workflow tests. Playwright starts a local
Worker on a fixed port, uses real sessions and fixture analysis, and cleans its reserved
synthetic rows. It preserves an existing `.dev.vars` and rejects a file that does not enable
the expected local fixture/bypass modes. Fixture success verifies code paths; the live-provider
and hosted rollout sign-offs are tracked separately in the migration plan.

## Configurations and bindings

| Item                           | Staging                                         | Production                          |
| ------------------------------ | ----------------------------------------------- | ----------------------------------- |
| Config                         | `apps/web/wrangler.jsonc`                       | `apps/web/wrangler.production.json` |
| Worker                         | `tracera-staging`                               | `tracera`                           |
| Origin                         | `https://tracera-staging.voltcrash.workers.dev` | `https://tracera.voltcrash.com`     |
| D1 / `DB`                      | `tracera-staging`                               | `tracera-production`                |
| R2 / `BLOBS`                   | `tracera-staging-blobs`                         | `tracera-production-blobs`          |
| Workflow / `ANALYSIS_WORKFLOW` | `tracera-staging-analysis`                      | `tracera-production-analysis`       |

Both use account `eb2679ce4f23ae7db4e6c4e3fcf8c3c1`. Production disables workers.dev and
preview URLs. The actual resource UUIDs live in the configs and the Stage 0 inventory.
Local development emulates the bindings and does not query those hosted databases.

Private files are `.dev.vars` for local development, `.dev.vars.staging` for hosted staging
preparation, and `.dev.vars.production` for production. All live under `apps/web`, are ignored,
and should have mode `0600`. Keep secret values out of public vars, screenshots, logs, and Git.
Runtime code reads `cloudflare:workers` bindings through the validated server environment;
build scripts and evaluator CLIs use their own explicit inputs.

Hosted credentials use distinct auth secrets and OAuth apps. Preserve the Stage 0 generated
secrets in `/Users/lakshmi/.t3/private/tracera/stage-0/` when preparing the hosted files.
A partial GitHub or Google pair is rejected. GitHub is required for initial production;
Google credentials remain optional until the final Phase 4.4.
