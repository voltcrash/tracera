# Stage 3 cleanup and release preparation

The owner requested on 2026-10-12 that the remaining repository implementation proceed before
the live-provider test. Phase 2.6 remains pending. Stage 4 deployments, cutover, decommission,
and hosted OAuth checks still require approval and their own sign-offs.

Stage 3 follows the accepted migration plan: remove legacy code, rewrite operations docs, then
replace CI and port the oxytype daily release workflow. Each phase has a separate stacked PR
and small validated commits. The Phase 3.1 PR also removes transitional CI calls to the deleted
tooling; the full replacement CI and release workflow land in Phase 3.3.
