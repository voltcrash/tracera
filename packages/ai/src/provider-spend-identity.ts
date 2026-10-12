import type { AiProviderCallKind } from "./provider";
import type { AiProviderConfig, AiProviderName } from "./create-provider";
import type { ProviderKeySource } from "./resolve-analysis-provider";

export interface ProviderSpendIdentity {
  providerKey: AiProviderName;
  keySource: ProviderKeySource;
}

export function providerSpendIdentity(
  resolved: { source: ProviderKeySource; config: AiProviderConfig },
  kind: AiProviderCallKind,
): ProviderSpendIdentity {
  return {
    providerKey:
      kind === "embed"
        ? (resolved.config.embedding?.provider ?? resolved.config.provider)
        : resolved.config.provider,
    keySource: resolved.source,
  };
}
