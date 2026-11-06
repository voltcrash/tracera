import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import type { AiProvider } from "@repo/ai";
import { createD1SpendRepository } from "@repo/db";
import { createTestRuntime } from "@repo/db/test-runtime";
import { analysisControlConfig, spendLimitedAiProvider } from "../src/server/analysis-controls";
let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
beforeEach(async () => {
  runtime = await createTestRuntime();
});
afterEach(async () => {
  await runtime?.dispose();
});
function underlying(embed = vi.fn(async () => [1])): AiProvider {
  return {
    generate: async (_prompt, schema) => schema.parse({ answer: "ok" }),
    generateFromImage: async (_prompt, _image, schema) => schema.parse({ answer: "ok" }),
    embed,
  };
}
const config = { provider: "openai" as const, model: "fixture" };

test.each([false, true])(
  "a settled reservation cannot execute again after failure=%s",
  async (failure) => {
    const store = createD1SpendRepository({ database: runtime.db });
    const embed = vi.fn(async () => {
      if (failure) throw new Error("Provider failed");
      return [1];
    });
    const provider = spendLimitedAiProvider(underlying(embed), config, analysisControlConfig({}), {
      reserveProviderSpend: (input) =>
        store.reserveProviderSpend({ ...input, reservationId: "one-physical-operation" }),
      settleProviderSpend: (input) => store.settleProviderSpend(input),
    });
    if (failure) await expect(provider.embed("fixture")).rejects.toThrow("Provider failed");
    else expect(await provider.embed("fixture")).toEqual([1]);
    await expect(provider.embed("fixture")).rejects.toMatchObject({
      code: "analysis_controls_unavailable",
    });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(
      await runtime.db
        .prepare("SELECT settlement_basis FROM ai_spend_reservations")
        .first("settlement_basis"),
    ).toBe("estimated");
    expect(
      await runtime.db
        .prepare(
          "SELECT actual_micros,estimated_settled_micros,measured_settled_micros FROM ai_provider_spend",
        )
        .first(),
    ).toEqual({ actual_micros: 100, estimated_settled_micros: 100, measured_settled_micros: 0 });
  },
);

test("an unfunded generation cannot prevent a cheaper embedding from executing", async () => {
  const store = createD1SpendRepository({ database: runtime.db });
  const embed = vi.fn(async () => [1]);
  const provider = spendLimitedAiProvider(
    underlying(embed),
    config,
    analysisControlConfig({ AI_DAILY_SPEND_LIMIT_USD: "0.001" }),
    store,
  );
  await expect(
    provider.generate("fixture", z.object({ answer: z.string() })),
  ).rejects.toMatchObject({ code: "provider_spend_limit" });
  expect(await provider.embed("fixture")).toEqual([1]);
  expect(embed).toHaveBeenCalledTimes(1);
});

test.each([
  [0.0000011, 2],
  [0.0000001, 1],
])("the wrapper preserves a $%s estimate until D1 rounds up", async (estimate, micros) => {
  const store = createD1SpendRepository({ database: runtime.db });
  const embed = vi.fn(async () => [1]);
  const provider = spendLimitedAiProvider(
    underlying(embed),
    config,
    analysisControlConfig({ AI_ESTIMATED_EMBEDDING_COST_USD: String(estimate) }),
    store,
  );
  expect(await provider.embed("fixture")).toEqual([1]);
  expect(embed).toHaveBeenCalledTimes(1);
  expect(
    await runtime.db
      .prepare("SELECT estimated_micros FROM ai_spend_reservations")
      .first("estimated_micros"),
  ).toBe(micros);
  expect(
    await runtime.db
      .prepare("SELECT estimated_settled_micros FROM ai_provider_spend")
      .first("estimated_settled_micros"),
  ).toBe(micros);
});
