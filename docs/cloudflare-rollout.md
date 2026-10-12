# Cloudflare rollout runbook

This is reviewable preparation for Stage 4, not a record of completed hosted work. Follow the
[migration plan](cloudflare-migration-plan.md) in phase order. The owner deferred the Phase 2.6
live-provider test until repository implementation is finished. Deployments, secret uploads,
DNS/OAuth changes, and decommission require approval of concrete actions before execution.

| Gate                          | Status                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------- |
| Phase 2.6 local live analysis | Pending owner credentials, explicit bounds, and live result                       |
| Phase 4.1 staging soak        | Pending approved secrets/deploy and signed live checks                            |
| Phase 4.2 production cutover  | Pending staging sign-off and approved cutover batch                               |
| Phase 4.3 decommission        | Pending agreed stable period, archive, deletion approvals, restore drill          |
| Phase 4.4 Google OAuth        | Pending final registration/credential approval, code PR, deploy, browser sign-off |

Record dates, reviewers, commit/Worker versions, run IDs, and outcomes beneath each gate.
Keep keys, OAuth secrets, cookies, private inputs, and logs containing private data outside Git.
Commands using `RUN_ID`, `BOOKMARK`, or private paths are templates; resolve them before
presenting an exact approval batch. The following commands have not been executed here.

## Phase 4.1 — Staging soak

1. Complete the deferred local `vp run dev:live` analysis with owner-configured provider/model
   settings and explicit run/spend bounds in `.dev.vars`. Record its result and usage.
2. Prepare `.dev.vars.staging`, preserving the Stage 0 auth secret and completed staging GitHub
   registration. Review the complete credentials and budget setting names without displaying
   their values. Use the [staging guide](staging-setup.md).
3. Present and approve this hosted batch before running it:

```sh
vp exec --filter web -- wrangler secret bulk .dev.vars.staging --config wrangler.jsonc
vp run deploy:staging
```

4. Record the deployed commit, Worker version, applied D1 migrations, and test window. Use real
   GitHub sign-in and bounded real-provider inputs for the checks below.

- [ ] GitHub callback succeeds; reload retains the session; sign-out clears it.
- [ ] Settings show linked accounts and run history belongs to the signed-in owner.
- [ ] Text, public-link, and screenshot analyses persist reports and exact evidence.
- [ ] Progress streaming survives reload; terminal states match the stored run.
- [ ] Cancellation reaches the Workflow instance and releases admission/spend state.
- [ ] An injected or observed retry resumes from a checkpoint without duplicate finalization.
- [ ] Replayed requests preserve their idempotency key and return the same stored response.
- [ ] Conflicting keys, rate/concurrency limits, daily quota, and spend circuit fail as intended.
- [ ] Browser console and network checks show no CSP violations or private-secret exposure.
- [ ] Worker logs, Workflow instances, D1 metrics, and provider usage reconcile with test runs.
- [ ] Required live evaluation prerequisites are met and its real results are recorded.

Read-only diagnostics after deployment:

```sh
vp exec --filter web -- wrangler tail --config wrangler.jsonc
vp exec --filter web -- wrangler workflows instances describe tracera-staging-analysis RUN_ID --json
vp exec --filter web -- wrangler d1 info tracera-staging --config wrangler.jsonc
```

Use temporary staging control values only through an approved change, then restore the
reviewed normal values. Do not stress-test with an unbounded provider account. The full release
evaluator currently rejects live mode until human-gold, authorization, and connector
prerequisites are supplied; fixture metrics cannot close this gate.

Sign-off: **pending**. Record reviewer, UTC window, model names, approved bounds, input types,
run/instance IDs, verdict/evidence checks, observed usage, and any unresolved failures.
