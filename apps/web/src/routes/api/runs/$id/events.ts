import { createFileRoute } from "@tanstack/react-router";
import { runEventsResponse } from "@/server/api-routes.server";
import { serverEnv } from "@/server/env";

export const Route = createFileRoute("/api/runs/$id/events")({
  server: {
    handlers: {
      GET: ({ request, params }) => runEventsResponse(serverEnv(), request, params.id),
    },
  },
});
