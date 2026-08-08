import { serve } from "@hono/node-server";
import { app } from "./index.js";

const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Tracera API listening on http://localhost:${port}`);
});
