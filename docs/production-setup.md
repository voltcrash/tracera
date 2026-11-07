# Production setup

Production uses one Worker at `https://tracera.voltcrash.com` and the explicit
`apps/web/wrangler.production.json` config. Production workers.dev and preview URLs are disabled.

| Resource               | Production                                                   |
| ---------------------- | ------------------------------------------------------------ |
| Worker / custom domain | `tracera` / `tracera.voltcrash.com`                          |
| D1                     | `tracera-production`, `26eeb656-2c46-4182-ad48-4bd696684b01` |
| R2                     | `tracera-production-blobs`                                   |
| Workflow               | `tracera-production-analysis`                                |

## Private settings

Create ignored `apps/web/.dev.vars.production` from the production example, using mode `0600`.
Preserve the deployed auth secret and complete production GitHub and Google OAuth credentials.
Credentials must differ from staging, and placeholders fail validation. Omit `DEV_AUTH_BYPASS`
and `VERSION`; the build assigns its own identity.

Production callbacks use `/api/auth/callback/github` and `/api/auth/callback/google` on the
production origin. Non-secret operational settings can use reviewed Wrangler vars.

AI configuration is optional. Without provider settings, production serves sign-in, history,
and settings while analysis reports that it is unavailable. Enabling platform analysis needs
its provider, generation and embedding models, keys, and every run/spend bound together.
For BYOK-only analysis, configure an independent `PROVIDER_KEYS_ENCRYPTION_KEY`, all run bounds,
and the three cost estimates. Platform credentials and the platform daily spend budget may
remain absent. See [bring your own key](bring-your-own-key.md).

## Local preflight

With complete private settings available:

```sh
vp install
vp check
vp test --run
vp run build:production
vp run check:production
vp run deploy:production-dry-run
```

`build:production` validates inputs, performs one fresh compiler invocation against the production
config, and seals the output with an integrity receipt. The receipt excludes local preview secrets.
`check:production` verifies existing output, isolated resources, secrets, live-analysis controls,
file fingerprints and matching Worker/client build IDs. It does not build. The dry-run checks
and packages that same artifact without uploading or making remote database changes.

A normal staging build replaces `dist`, so rebuild production before production validation.
An artifact with changed, missing or additional files fails validation. Keep secrets out of
build artifacts and preserve the existing private file when repeating setup.

## Production deployments

The [production workflow](../.github/workflows/production-release.yml) automatically runs after
[CI](../.github/workflows/ci.yml) succeeds for a push to `main`. It checks out that CI run's exact
SHA only if it still matches current `main` before preparation and immediately before migrations.
Each check independently requires the latest main-push CI result for that SHA to be successful.
Release policy loads from the workflow's SHA before the exact eligible candidate is checked out,
so a delayed older candidate cannot supply its own eligibility code. PR, fork, failed and
cancelled runs cannot deploy. GitHub permissions are Contents and Actions read only.

Configure these secrets in the GitHub `production` environment:

| Secret                  | Value                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Selected account's Worker/custom-domain operations and D1 edit access |
| `PRODUCTION_WORKER_ENV` | Complete contents of the private `.dev.vars.production` file          |

The workflow validates CI, writes private settings, installs dependencies, builds once,
dry-runs, applies production migrations and `PRAGMA optimize`, then deploys. Before upload,
the deployment command enables D1 read replication and verifies the persisted setting.
Cloudflare API errors or an identity mismatch stop deployment. Private settings are always
removed, and concurrent production deployments remain serialized. The queue retains pending
candidates with `queue: max`; eligibility checks handle their order rather than assuming CI
completion order matches commit order. See [GitHub's concurrency rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

The final job summary records the commit and an explicit outcome:

| Outcome                 | Meaning and recovery                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `blocked`               | Eligibility was unavailable or CI was not successful; no production mutation started                  |
| `superseded`            | Main advanced before cutover; this candidate skips migration and upload                               |
| `preflight_incomplete`  | Preparation or the final eligibility check failed; fix it and retry current main after CI             |
| `migration_incomplete`  | Migration may have changed D1; inspect applied migrations and retry forward                           |
| `deployment_incomplete` | Migration succeeded but Worker activation is unconfirmed; inspect the active Worker and retry forward |
| `deployed`              | Migration and deployment commands reported success                                                    |

Once the final eligibility check passes, migration and upload finish under the same concurrency
lock even if main advances. A newer candidate waits. Rechecking the head after migration could
leave the old Worker serving a newer schema, so supersession only stops work before cutover.
Superseded jobs finish unsuccessfully to avoid recording a successful production environment
deployment when no upload ran. Their summary identifies supersession explicitly.

Worker metadata and `/version.json` share the internal ID `SHA-run ID-run attempt`. Each retry
gets its own ID. Local builds receive a unique local ID. There are no dated website releases,
GitHub release records, release tags, changelogs or same-day allocation limits.

Manual retries from `main`, including unchanged commits, use:

```sh
gh workflow run production-release.yml --repo voltcrash/tracera --ref main
```

This performs a hosted deployment and requires successful main-push CI for the selected snapshot.
It does not bypass the gate or permit deployment from a feature branch.

## Database behavior and recovery

Migrations precede Worker upload. They cannot be atomic with a Worker deployment. New migrations
must support the currently serving Worker until upload finishes; incompatible changes need staged
expand/contract releases or a separately planned maintenance window. Test both old and new writers
against the migrated schema. Existing constraints, including provider-key revisions introduced in
migration `0013`, must be considered before reverting code; applied migrations are not edited here.

If a runner stops before the summary, inspect migration/upload step conclusions and Wrangler logs.
A failed upload does not establish which Worker is active. Inspect it before retrying the latest
CI-approved main commit. No database restore or Worker rollback happens automatically.

Replica activation is idempotent and targets the configured
D1 UUID and name. The token needs D1 edit access. Dry-run commands never invoke migration,
optimization or replica activation. Local migrations run only local optimization.

Enabling replicas makes them available; Tracera's existing runtime queries still use the primary
path. Using replicas for reads requires a separate Sessions API integration with consistency
rules for auth and analysis controls. See [Cloudflare's replication documentation](https://developers.cloudflare.com/d1/best-practices/read-replication/).

Deploy a reviewed revert through `main` and successful CI when rolling back code. Check
compatibility with already-applied migrations first: Worker deployment does not undo a database
migration. D1 restore, auth-key rotation and OAuth changes remain separate operational actions.
See [Cloudflare operations](cloudflare-operations.md#d1-capacity-and-time-travel) for D1 recovery.
