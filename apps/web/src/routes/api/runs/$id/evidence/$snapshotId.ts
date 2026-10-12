import { createFileRoute } from "@tanstack/react-router";
import { evidenceResponse } from "@/server/api-routes.server";
import { serverEnv } from "@/server/env";

export const Route = createFileRoute("/api/runs/$id/evidence/$snapshotId")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        evidenceResponse(serverEnv(), request, params.id, params.snapshotId),
    },
  },
});
