import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  ANALYSIS_ERROR_MESSAGES,
  AnalysisError,
  publicAnalysisError,
} from "../src/server/analysis-errors";

test("known analysis failures retain a stable client code and message", () => {
  assert.deepEqual(publicAnalysisError(new AnalysisError("no_checkable_claims")), {
    code: "no_checkable_claims",
    message: ANALYSIS_ERROR_MESSAGES.no_checkable_claims,
    status: 422,
  });
});

test("internal failure details are replaced with a stable unavailable response", () => {
  const failure = publicAnalysisError(
    new Error("connection to postgresql://admin:secret@private-db failed"),
  );
  assert.deepEqual(failure, {
    code: "analysis_unavailable",
    message: ANALYSIS_ERROR_MESSAGES.analysis_unavailable,
    status: 503,
  });
  assert.doesNotMatch(JSON.stringify(failure), /admin|secret|private-db/);
});
