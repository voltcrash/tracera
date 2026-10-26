# Staging setup

Staging runs at `https://tracera-staging.voltcrash.workers.dev`. Use `apps/web/wrangler.jsonc`
and its separate D1, R2, and Workflow resources.

## Private preparation

Create ignored `apps/web/.dev.vars.staging` with mode `0600`, preserving an existing file,
staging auth secret, and OAuth credentials. Keep the local `.dev.vars` in fixture/development mode.
The hosted file must contain its auth secret and complete OAuth credential pairs. For platform
analysis, configure provider/model/key settings and explicitly chosen run/spend bounds described
in [Cloudflare operations](cloudflare-operations.md).
It must omit `DEV_AUTH_BYPASS`; hosted config already selects production/live mode and its
HTTPS auth origin. Google sign-in uses the staging credential pair and callback
`https://tracera-staging.voltcrash.workers.dev/api/auth/callback/google`; partial pairs are rejected.

Staging may instead use personal AI keys with its own `PROVIDER_KEYS_ENCRYPTION_KEY`, run
bounds, and cost estimates. Keep its encryption material separate from production; platform
provider settings remain optional. See [bring your own key](bring-your-own-key.md).

Staging GitHub registration:

| Field    | Value                                                                    |
| -------- | ------------------------------------------------------------------------ |
| Homepage | `https://tracera-staging.voltcrash.workers.dev`                          |
| Callback | `https://tracera-staging.voltcrash.workers.dev/api/auth/callback/github` |

Verify the selected Cloudflare account with `vp exec --filter web -- wrangler whoami`
before uploading secrets or deploying.

## Deployment

Build and dry-run the Worker locally:

```sh
vp run web#deploy:staging-dry-run
```

With the private settings prepared, upload the complete file and deploy from the repository root:

```sh
vp exec --filter web -- wrangler secret bulk .dev.vars.staging --config wrangler.jsonc
vp run deploy:staging
```

The deploy script applies remote staging D1 migrations before the build and deployment.
Secret upload retains other existing secrets; inspect secret names and remove any obsolete
bypass or fixture override. The Worker must serve pages, auth, server functions, and progress
from the same origin.

## Hosted validation

Use real GitHub sign-in and confirm session persistence across reloads, sign-out, run history,
and linked accounts in settings. Complete bounded text, public-link, and screenshot analyses;
check progress, evidence, report persistence, cancellation, and browser CSP violations.
Exercise rate/concurrency limits, daily quota, idempotent replay/conflict, and the spend circuit.
Review Worker logs, Workflow instances, D1 metrics, and provider usage before signing off.

Fixture CI does not sign off hosted OAuth, provider access, live retrieval quality, or real
usage/billing. Record the test inputs, run/instance IDs, model names, approved bounds, UTC test
window, and outcomes without including credentials or private uploads.
The live release evaluator's human-gold and authorization prerequisites remain separate.
