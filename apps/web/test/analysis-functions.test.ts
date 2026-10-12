import { expect, test } from "vite-plus/test";
import {
  MAX_ANALYSIS_INPUT_BYTES,
  validateStartAnalysisInput,
} from "../src/server/analysis.functions";

test("startAnalysis accepts an idempotency key with one input object", () => {
  expect(
    validateStartAnalysisInput({ idempotencyKey: "key", input: { text: "A claim." } }),
  ).toEqual({
    idempotencyKey: "key",
    input: { text: "A claim." },
  });
});

test.each([null, {}, { idempotencyKey: 1, input: {} }, { idempotencyKey: "key", input: [] }])(
  "startAnalysis rejects malformed input %o",
  (value) => {
    expect(() => validateStartAnalysisInput(value)).toThrow(
      "idempotency key and an analysis input",
    );
  },
);

test("the 7.1 MB body limit moved into the startAnalysis validator", () => {
  const image = `data:image/png;base64,${"A".repeat(MAX_ANALYSIS_INPUT_BYTES)}`;
  expect(() => validateStartAnalysisInput({ idempotencyKey: "key", input: { image } })).toThrow(
    "Request body is too large.",
  );
});
