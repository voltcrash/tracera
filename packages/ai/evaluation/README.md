# Model validation gate

Run this before approving a generation model for production:

```sh
AI_PROVIDER=... AI_API_KEY=... AI_MODEL=... vp run @repo/ai#validate:model
```

The checked-in dataset contains six mixed true, false, and misleading claims
from real published articles. Each case uses a fixed evidence fixture so the
evaluation measures claim extraction and verdict generation rather than search
API availability. Pass a different JSON file as the first argument to evaluate
another 5–10 case set.

The command exits non-zero unless extraction, atomicity, verdict accuracy,
evidence use, structured-output reliability, and latency meet their configured
thresholds. It prints a JSON report containing per-case reasoning for mandatory
human review. Override thresholds with `--min-extraction-rate`,
`--min-atomicity-rate`, `--min-verdict-rate`, `--min-evidence-use-rate`,
`--min-schema-rate`, or `--max-p95-latency-ms`. Pass both
`--input-usd-per-million-tokens` and `--output-usd-per-million-tokens` to add an
estimated cost.

Production approval requires both `approved: true` and a human review confirming
that claims are genuinely atomic and reasoning is supported by the cited fixture.

## Core-overhaul evaluation harness

The version-neutral harness is separate from the six-case legacy model gate above. Its default fixture mode is deterministic and uses no network, credentials, or database:

```sh
vp run @repo/ai#evaluate:core --mode fixture --split all --seed 20260910
```

Replay mode requires a checked adapter-run JSON, while live mode invokes the v1 adapter and requires the configured provider credentials:

```sh
vp run @repo/ai#evaluate:core --mode replay --dataset path/to/dataset.json --replay path/to/run.json --split test --seed 42
vp run @repo/ai#evaluate:core --mode live --dataset path/to/dataset.json --split development --seed 42
```

Use `--baseline path/to/v1-run.json` for paired clustered-bootstrap comparison and `--output path/to/report.json` to save the JSON report. A replay/live gate failure or unevaluated required gate exits nonzero. Fixture mode gates only detector behavior; its synthetic labels remain excluded from empirical metrics.

Dataset format is defined by `schemas.ts`; it records immutable content hashes, exact spans, language, as-of/acquisition times, event and source-family groups, split, annotators, adjudication, origin expectations, and licensing. Approximate extraction matches are queued for human review rather than counted as correct.
