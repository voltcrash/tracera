import { createFileRoute } from "@tanstack/react-router";
import { healthResponse } from "@/server/api-routes.server";
import { serverEnv } from "@/server/env";

export const Route = createFileRoute("/api/health")({
  server: { handlers: { GET: ({ request }) => healthResponse(serverEnv(), request) } },
});
