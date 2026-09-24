# Core v2 evaluation

The shared schemas and metric helpers in this directory support the Core v2 stage evaluators.
Run the focused product fixture with no network, credentials, or database:

```sh
vp run evaluate:core-focused:fixture
```

Additional claim, evidence, retrieval, provenance, adjudication, scoring, orchestration, and
release fixtures are registered in the root `package.json`. Fixture results exercise code paths
only; synthetic labels remain excluded from empirical accuracy and release metrics.

Dataset format is defined by `schemas.ts`; it records immutable content hashes, exact spans,
language, as-of/acquisition times, event and source-family groups, split, annotators,
adjudication, origin expectations, and licensing. Approximate extraction matches are queued for
human review rather than counted as correct.
