# Stage 0 resource preparation

Date: 2026-10-11. Phase 0.3 is **incomplete**. R2 activation is verified; creation and
deployment commands were approved as a six-command batch. Google staging OAuth is deferred at the
owner's request. GitHub staging OAuth and the scoped CI token remain pending.

This phase follows section 3 and Phase 0.3 of the
[migration plan](cloudflare-migration-plan.md). Its PR contains documentation only.
Resource bootstrap artifacts live outside the repository and do not implement the product.
Do not advance to Stage 1 until the remaining Phase 0.3 requirements are resolved.

## Account and inventory

The selected Cloudflare account is `eb2679ce4f23ae7db4e6c4e3fcf8c3c1`, with the
`voltcrash.workers.dev` subdomain. Read-only Wrangler inventory found no Tracera D1
databases, Workers, or Workflows. The existing oxytype resources are separate.

The initial R2 list failed with error 10042 because R2 was disabled. After the owner
enabled R2 in the Dashboard, listing buckets succeeded and returned an empty inventory.
R2 activation is no longer the blocker. Approved resource creation is in progress.

## Staging resource manifest

| Resource      | Name or origin                                  | Binding             | ID and state                                            |
| ------------- | ----------------------------------------------- | ------------------- | ------------------------------------------------------- |
| Worker        | `tracera-staging`                               | —                   | Deployed; bootstrap version below                       |
| Public origin | `https://tracera-staging.voltcrash.workers.dev` | —                   | Verified HTTP 503 bootstrap response                    |
| D1            | `tracera-staging`                               | `DB`                | `4df15d26-839d-46aa-a7fa-341c228569c2`; created in APAC |
| R2            | `tracera-staging-blobs`                         | `BLOBS`             | Created; Standard storage, private bucket               |
| Workflow      | `tracera-staging-analysis`                      | `ANALYSIS_WORKFLOW` | Created; class `AnalysisWorkflow`                       |

Stage 2's default `apps/web/wrangler.jsonc` must use these hosted names and the real D1
UUID. Local development uses Miniflare copies in that worktree's `.wrangler/state`.
The all-zero UUID in the throwaway spike is valid only for local work and dry runs.

## Production resource manifest

| Resource             | Name or origin                  | Binding             | ID and state                                            |
| -------------------- | ------------------------------- | ------------------- | ------------------------------------------------------- |
| Worker               | `tracera`                       | —                   | Deployed; bootstrap version below                       |
| Future public origin | `https://tracera.voltcrash.com` | —                   | Custom-domain activation belongs to Stage 4             |
| D1                   | `tracera-production`            | `DB`                | `26eeb656-2c46-4182-ad48-4bd696684b01`; created in APAC |
| R2                   | `tracera-production-blobs`      | `BLOBS`             | Created; Standard storage, private bucket               |
| Workflow             | `tracera-production-analysis`   | `ANALYSIS_WORKFLOW` | Created; class `AnalysisWorkflow`                       |

Stage 2's separate `apps/web/wrangler.production.json` must use these resources. Production
disables workers.dev and preview URLs. The Stage 0 bootstrap also has an empty routes
array, so resource creation cannot claim the current Vercel hostname. Add the planned
custom-domain route only through Stage 4's approved cutover steps.

## Staging Worker deployment

The approved deployment created Worker `tracera-staging`, version
`375cd268-d98a-4a6c-9fae-6b9cb78c2e51`, with message `Stage 0 resource bootstrap`.
Its cron is `17 * * * *`. The deployed artifact is 0.75 KiB before gzip.

An HTTPS request to the staging origin returned HTTP 503, `cache-control: no-store`, and
`{"service":"tracera","stage":0,"status":"migration-pending"}`. This is the intended
bootstrap response. Authentication and analysis are implemented in later stages.

## Staging Workflow

Read-only `wrangler workflows list` confirms `tracera-staging-analysis` belongs to
`tracera-staging` and uses class `AnalysisWorkflow`. The binding is `ANALYSIS_WORKFLOW`.
The bootstrap exports a valid step but creates no analysis instances. Stage 2 replaces
that implementation with the planned analysis pipeline.

## Production Worker deployment

The approved deployment created Worker `tracera`, version
`9a424fa8-6bee-4966-918b-0c2c8935fb3e`, with message `Stage 0 resource bootstrap` and cron
`17 * * * *`. Wrangler reported no public URL for this deployment. The reviewed config
sets `workers_dev: false`, `preview_urls: false`, and `routes: []`.

No custom domain, DNS record, Vercel setting, or Neon resource was changed. Production
resource provisioning leaves the current site serving until Stage 4.

## Production Workflow

Read-only `wrangler workflows list` confirms `tracera-production-analysis` belongs to
`tracera` and uses class `AnalysisWorkflow`. It has its own `ANALYSIS_WORKFLOW` binding
and is separate from staging. No production Workflow instance was started.

## Authentication secrets

New, independent `BETTER_AUTH_SECRET` values were generated for staging and production.
Each is 64 base64url characters from 48 random bytes. Validation confirmed distinct
values, file mode 0600, and parent-directory mode 0700 without displaying the values.

Private files on the operator's machine:

- `/Users/lakshmi/.t3/private/tracera/stage-0/.dev.vars.staging`
- `/Users/lakshmi/.t3/private/tracera/stage-0/.dev.vars.production`

Both files are outside Git. They currently contain only their environment's auth secret;
OAuth credentials and provider keys have not been added. No secrets were uploaded to
Cloudflare or GitHub. Keep existing production OAuth credentials private when preparing
the later production file, and retain these newly generated auth secrets for D6.

Stage 2 adopts oxytype's ignored `.dev.vars` and `.dev.vars.production` files and
`--secrets-file` deployment pattern. Approval for resource bootstrap did not authorize
a later secrets upload or an application deployment.

## Bootstrap source

The resource-only source is `/tmp/tracera-stage-0/provisioning/server.js`. Recreate it
from this record if the temporary directory is lost. Its Workflow export allows the
deployment to create the named Workflow resources; the scheduled handler is a no-op.
The app, schema, migrations, and provider calls do not land in Stage 0.

```js
import { WorkflowEntrypoint } from "cloudflare:workers";

export class AnalysisWorkflow extends WorkflowEntrypoint {
  async run(_event, step) {
    return await step.do("bootstrap", async () => ({ stage: 0, status: "migration-pending" }));
  }
}

export default {
  fetch() {
    return Response.json(
      { service: "tracera", stage: 0, status: "migration-pending" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  },
  scheduled() {},
};
```

## Staging bootstrap config

The reviewed `/tmp/tracera-stage-0/provisioning/wrangler.jsonc` received only the real
D1 ID before deployment. Both placeholder-ID and final-ID dry runs passed with
Wrangler 4.149.0 from the throwaway toolchain spike.

```json
{
  "name": "tracera-staging",
  "main": "server.js",
  "account_id": "eb2679ce4f23ae7db4e6c4e3fcf8c3c1",
  "compatibility_date": "2026-10-11",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "preview_urls": false,
  "observability": {
    "enabled": true
  },
  "triggers": {
    "crons": ["17 * * * *"]
  },
  "vars": {
    "MODE": "production",
    "BETTER_AUTH_URL": "https://tracera-staging.voltcrash.workers.dev",
    "VERSION": "stage-0-bootstrap"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "tracera-staging",
      "database_id": "4df15d26-839d-46aa-a7fa-341c228569c2"
    }
  ],
  "r2_buckets": [
    {
      "binding": "BLOBS",
      "bucket_name": "tracera-staging-blobs"
    }
  ],
  "workflows": [
    {
      "binding": "ANALYSIS_WORKFLOW",
      "name": "tracera-staging-analysis",
      "class_name": "AnalysisWorkflow"
    }
  ]
}
```

## Production bootstrap config

The reviewed `/tmp/tracera-stage-0/provisioning/wrangler.production.json` likewise
received only the real D1 ID before deployment. Both dry runs passed. Separate configs
and resources follow oxytype; adding the custom-domain route remains a Stage 4 action.

```json
{
  "name": "tracera",
  "main": "server.js",
  "account_id": "eb2679ce4f23ae7db4e6c4e3fcf8c3c1",
  "compatibility_date": "2026-10-11",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "routes": [],
  "observability": {
    "enabled": true
  },
  "triggers": {
    "crons": ["17 * * * *"]
  },
  "vars": {
    "MODE": "production",
    "BETTER_AUTH_URL": "https://tracera.voltcrash.com",
    "VERSION": "stage-0-bootstrap"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "tracera-production",
      "database_id": "26eeb656-2c46-4182-ad48-4bd696684b01"
    }
  ],
  "r2_buckets": [
    {
      "binding": "BLOBS",
      "bucket_name": "tracera-production-blobs"
    }
  ],
  "workflows": [
    {
      "binding": "ANALYSIS_WORKFLOW",
      "name": "tracera-production-analysis",
      "class_name": "AnalysisWorkflow"
    }
  ]
}
```
