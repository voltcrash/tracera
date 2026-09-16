import { test } from "vite-plus/test";
import { FOCUSED_SCENARIOS, runFocusedScenario } from "../scripts/support/focused-scenarios.js";

for (const scenario of FOCUSED_SCENARIOS) {
  test(`focused invariant fixture: ${scenario}`, async () => {
    await runFocusedScenario(scenario);
  });
}
