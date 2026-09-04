import { serve } from "@hono/node-server";
import { server } from "./server.js";

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: (request) => server.fetch(request, process.env), port }, (info) => {
  console.log(`Tracera server listening on http://localhost:${info.port}`);
});
