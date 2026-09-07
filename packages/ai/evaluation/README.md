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
