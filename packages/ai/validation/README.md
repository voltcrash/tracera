# Gemma Step 0 validation

`gemma4-e2b-step0.json` is the recorded 2026-08-08 evaluation of the locally
installed `gemma4:e2b` Ollama model. The five cases use short paraphrased
excerpts tied to cited public primary-source or public-health material. They
cover supported, false/conspiratorial, absolute health, nuanced health, and
manipulative-framing claims.

Run the evaluation from the repository root:

```sh
GEMMA_VALIDATION_OUTPUT=validation/gemma4-e2b-step0.json \
  pnpm --filter @repo/ai validate:gemma
```

The model template has a single `Prompt` field, so the Ollama provider folds
the instructions and schema into the user prompt instead of sending a native
system message. The provider also caps local structured responses at 512
tokens (`OLLAMA_MAX_TOKENS`) to prevent a malformed response from monopolizing
an analysis request.

## Result and decision

This run does **not** clear `gemma4:e2b` for production claim extraction and
verdict generation. Four of five cases completed; one returned no content.
The completed run measured 80% grounded/atomic claim extraction and 60%
expected-verdict agreement, with case latency from about 26 to 116 seconds.
Although completed calls conformed to the requested JSON schema without a
retry, semantic reliability and latency are insufficient.

Before selecting a production local model, rerun this corpus plus additional
real news articles against `gemma2:9b` and, where hardware permits,
`gemma2:27b`. A promotion decision must include human review of every claim
and verdict, not only the summary metrics.
