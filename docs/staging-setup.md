# Staging setup

The staged application will replace the Stage 0 bootstrap at
`https://tracera-staging.voltcrash.workers.dev`. Use `apps/web/wrangler.jsonc` and its separate
D1, R2, and Workflow resources. Application deployment and secret upload still require owner
approval; the resource-creation approval from Stage 0 does not cover them.

## Private preparation

Preserve the generated Stage 0 staging auth secret and existing GitHub staging credentials.
Copy the private Stage 0 file into ignored `apps/web/.dev.vars.staging` without replacing an
existing file, then use mode `0600`. Keep the local `.dev.vars` in fixture/development mode.
The hosted file must contain its auth secret, complete GitHub credentials, provider/model/key
settings, and explicitly chosen run/spend bounds described in `cloudflare-operations.md`.
It must omit `DEV_AUTH_BYPASS`; hosted config already selects production/live mode and its
HTTPS auth origin. Google remains deferred until Phase 4.4, and partial pairs are rejected.

Existing staging GitHub registration:

| Field    | Value                                                                    |
| -------- | ------------------------------------------------------------------------ |
| Homepage | `https://tracera-staging.voltcrash.workers.dev`                          |
| Callback | `https://tracera-staging.voltcrash.workers.dev/api/auth/callback/github` |

Do not create or change an OAuth app without approval. Verify the selected Cloudflare account
with `vp exec --filter web -- wrangler whoami` before presenting upload/deploy commands.

## Reviewable commands

Local build and dry run can run before approval:

```sh
vp run web#deploy:staging-dry-run
```

After private settings and the exact command batch are approved, upload the complete file and
deploy from the repository root:

```sh
vp exec --filter web -- wrangler secret bulk .dev.vars.staging --config wrangler.jsonc
vp run deploy:staging
```

The deploy script applies remote staging D1 migrations before the build and deployment.
Secret upload retains other existing secrets; inspect secret names and remove any obsolete
bypass or fixture override only through separately approved commands. The Worker must serve
pages, auth, server functions, and progress from the same origin.

## Phase 4.1 sign-off

Use real GitHub sign-in and confirm session persistence across reloads, sign-out, run history,
and linked accounts in settings. Complete bounded text, public-link, and screenshot analyses;
check progress, evidence, report persistence, cancellation, and browser CSP violations.
Exercise rate/concurrency limits, daily quota, idempotent replay/conflict, and the spend circuit.
Review Worker logs, Workflow instances, D1 metrics, and provider usage before signing off.

Fixture CI does not sign off hosted OAuth, provider access, live retrieval quality, or real
usage/billing. Record the test inputs, run/instance IDs, model names, approved bounds, UTC test
window, and outcomes in the rollout runbook without including credentials or private uploads.
The live release evaluator's human-gold and authorization prerequisites remain separate.
