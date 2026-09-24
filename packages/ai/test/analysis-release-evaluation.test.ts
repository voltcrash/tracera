import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  RELEASE_FIXTURE_SCENARIOS,
  runReleaseFixtureScenario,
} from "../scripts/support/release-scenarios.js";

for (const scenario of RELEASE_FIXTURE_SCENARIOS) {
  test(`release fixture: ${scenario}`, async () => {
    const result = await runReleaseFixtureScenario(scenario);
    assert.ok(result.checks.length > 0);
  });
}
