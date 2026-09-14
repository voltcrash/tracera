import type { SufficiencyFeedback } from "@repo/contracts/core-v2";
import { createRetrieveEvidenceV2 } from "../retrieval/index.js";
import type { ProvenanceRetrievalController } from "./types.js";

export function createProvenanceRetrievalController(
  retrievalOptions: Parameters<typeof createRetrieveEvidenceV2>[0] = {},
): ProvenanceRetrievalController {
  return {
    async retrieveReference(request, environment) {
      const reservedEnvironment = {
        ...environment,
        context: {
          ...environment.context,
          budget: {
            ...environment.context.budget,
            maxExternalRequests: Math.max(
              request.priorExternalRequests,
              environment.context.budget.maxExternalRequests - 1,
            ),
          },
        },
      };
      const retrieve = createRetrieveEvidenceV2({
        ...retrievalOptions,
        priorExternalRequests: request.priorExternalRequests,
        priorCostUsd: request.priorCostUsd,
      });
      const feedback: SufficiencyFeedback = {
        claimId: request.claim.id,
        sufficient: false,
        missing: ["independent_origin"],
        suggestedQueries: [{ query: request.reference.url, intent: "origin_trace" }],
        independentOriginCount: 0,
        unknownDependenceCount: 1,
      };
      return retrieve(
        {
          claims: [request.claim],
          snapshots: request.snapshots,
          round: 1,
          sufficiency: [feedback],
        },
        reservedEnvironment,
      );
    },
  };
}
