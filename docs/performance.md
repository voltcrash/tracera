# Performance measurements

These changes target history loading, report transport, and evidence storage and grouping.
Measurements below were taken locally with Node.js 24.22.1 and the repository's locked
Vite+ toolchain. They describe individual workloads, not hosted end-to-end analysis latency.

| Workload                               | Before                                 | After                                           |
| -------------------------------------- | -------------------------------------- | ----------------------------------------------- |
| History for 30 runs                    | 31 D1 queries plus full report reads   | 1 D1 query; stored summaries avoid report reads |
| Report route JavaScript                | 153.87 kB; 42.36 kB gzip               | 18.03 kB; 5.00 kB gzip                          |
| Complete report fixture sent to the UI | 9,974 bytes                            | 2,650 bytes                                     |
| Source grouping, 300 distinct sources  | 89.7 ms median                         | 8.7 ms median                                   |
| R2 snapshot reads within a bulk load   | Sequential                             | Up to 8 concurrent reads                        |
| History ordering                       | Temporary sort for tied creation times | Complete order served by the index              |

The report route chunk shrank by 88%, and the example report transport shrank by 73%.
The source-grouping measurement uses a synthetic CPU stress workload with 300 distinct
content hashes, passages, and publishers. It includes three warmups and nine measured calls;
old and new outputs were checked for equality. Local timing varies with machine load. It
does not measure AI provider latency, paid requests, network speed, or real-world accuracy.

## Implementation

History summaries store the selected headline beside the existing factual-score projection
when a report is finalized. Both summary history and full-report history use one scoped join
to the latest report version. The history index includes the run ID so equal creation times
retain deterministic ordering without an additional sort.

The browser receives the report's display projection through the run loader and
`/api/runs/:id/events?view=report`. Projection and report schema code stay on the server.
The default events endpoint continues to include the full stored report. Evidence excerpts
use the immutable snapshot already embedded in the authorized report.

Progress polling selects metadata without copying submitted input. Projection storage reuses
its canonical JSON string instead of serializing twice. Bulk snapshot loading overlaps at
most eight payload reads at a time and retains its existing ordering, hash checks, and access
scope. Source grouping indexes content hashes, normalized passages, and publisher metadata;
when hash and passage matches point to different roots, the earlier root still wins.
The primary interface font is preloaded from the same URL used by its stylesheet.

## Migration behavior

Apply migrations before deploying the Worker, through the existing deployment scripts.
Migration `0003_organic_sway.sql` adds the headline projection and backfills inline reports.
Reports already stored in R2 retain their original payload and use the legacy read fallback
when their headline projection is absent. Newly finalized reports, including large R2 reports,
write their summary in the same guarded publication batch.

Migration `0004_good_multiple_man.sql` rebuilds the existing history index with its final
sort column. Migration tests verify inline reports, opinion-only reports, empty reports, R2
fallback, and preservation of stored report bytes and hashes. No remote database migration
or deployment is part of the performance PR.

## Reproduce

From the repository root:

```sh
vp install
vp run benchmark:performance
vp check
vp test --run
vp run check-types
vp run build
vp exec --filter web --fail-if-no-match -- playwright install chromium
vp run test:browser
```

The benchmark prints current source-grouping timing and fixture transport sizes. To compare
CPU timing across revisions, run the same benchmark script and toolchain against both
implementations. The before values above were measured against the implementation preceding
`perf(evidence): index source dependence lookups`. The bundle baseline was built from
`dca5630` with the same dependencies and build command.

Regression coverage checks query count, owner isolation, legacy fallback, the query plan,
parallel-read bounds and ordering, copy-root precedence, and opt-in display streaming.
The standard browser suite covers text, link, and image Workflows and workspace navigation.
Fixture evidence, provenance, and release evaluations remain offline checks; they do not
provide empirical release approval or replace real-provider evaluation.
