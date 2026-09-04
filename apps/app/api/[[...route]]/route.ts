import { server } from "../../../server/server";

export const runtime = "nodejs";
export const maxDuration = 300;
// Analyses read live data and set session cookies, so nothing here is cacheable.
export const dynamic = "force-dynamic";

const handler = (request: Request) =>
  server.fetch(request, process.env as Record<string, string | undefined>);

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as OPTIONS,
  handler as HEAD,
};
