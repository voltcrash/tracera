# Core evaluation baseline

Report version: 1.0.0

Run date: 2026-09-10

Git parent: `55c749e252c725a1f6f3bf8748277f7db2d92f99`

Fixture dataset hash: `sha256:7b4caa72a9b0fa33c1a45d0dd1782aa30d78d2fb48884c61d5890732ea63daae`

Seed: `20260910`

## Current pipeline inventory

- Library orchestration: `packages/ai/src/pipeline/verify-text.ts` calls claim extraction, framing, retrieval, adjudication, and aggregation.
- Web orchestration: `apps/web/src/server/index.ts` separately calls normalization, extraction, retrieval, scoring, aggregation, and Ground Zero tracing.
- Public legacy exports: `packages/ai/src/index.ts` and `packages/ai/src/pipeline/index.ts`.
- Deterministic tests: `packages/ai/test/pipeline.test.ts` plus the repository suites.
- Six-case fixed-evidence model runner: `packages/ai/scripts/model-validation.ts` using `packages/ai/evaluation/model-validation.json`.
- Live pipeline runner: `packages/ai/scripts/pipeline-live-test.ts`.

## Executed baseline

`vp install` completed with the workspace already current. Before implementation, `vp test --run` passed 15 files and 69 tests. No provider-backed run was executed: the six legacy cases require provider credentials and model calls, so no model accuracy, latency, cost, or schema-reliability result is claimed here.

The deterministic core fixture contains 5 synthetic claims and 0 human-gold claims. The harness detected 4/4 injected violations: wrong verdict 1/1, invalid citation 1/1, future-evidence temporal leakage 1/1, and cross-split event contamination 1/1. These are code-smoke results only.

All empirical release metrics have denominator 0 and status `not_evaluated`. The initial corpus requirement remains 1,500 independently adjudicated claim instances from at least 300 stories: development 0/500, calibration 0/500, sealed test 0/500, with the additional later temporal holdout also absent. Release validation is blocked pending collection, two independent annotations per claim, adjudication, license review, and split freeze.

## Available versus unavailable evidence

Available: deterministic repository tests, synthetic invariant fixtures, versioned schemas, annotation policy, queue allocation, and candidate manifest.

Unavailable: human gold, authorized paid model runs, live retrieval runs, calibrated confidence data, matched v1/v2 comparisons, and independent citation-entailment audits. Synthetic and model labels must not be promoted into any of those categories.
