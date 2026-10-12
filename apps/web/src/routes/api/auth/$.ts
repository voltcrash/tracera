import { createFileRoute } from "@tanstack/react-router";
import { handleAuthRequest } from "@/server/auth-handler";
import { serverEnv } from "@/server/env";

const handle = ({ request }: { request: Request }) => handleAuthRequest(serverEnv(), request);

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: handle, POST: handle } },
});
