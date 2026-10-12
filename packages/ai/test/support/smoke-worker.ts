import type { R2Bucket } from "@cloudflare/workers-types";
import { createDocumentAcquisitionPort, createR2RawBlobStore } from "../../src/analysis/ingestion";
import { safeFetch } from "../../src/safe-fetch";

export default {
  async fetch(request: Request, env: { BLOBS: R2Bucket }) {
    const url = new URL(request.url);
    try {
      const store = createR2RawBlobStore(env.BLOBS);
      if (url.pathname === "/ingest") {
        const result = await createDocumentAcquisitionPort({
          now: () => "2026-10-12T00:00:00.000Z",
          rawBlobStore: store,
        }).acquire({
          url: url.searchParams.get("url")!,
          role: "submitted_input",
          maxBytes: 10_000,
          signal: request.signal,
        });
        return Response.json(result);
      }
      if (url.pathname === "/raw") {
        const bytes = await store.read(url.searchParams.get("uri")!, request.signal);
        return new Response(bytes ? new TextDecoder().decode(bytes) : null, {
          status: bytes ? 200 : 404,
        });
      }
      const response = await safeFetch(url.searchParams.get("url")!, { signal: request.signal });
      return new Response(await response.text(), { headers: { "x-final-url": response.url } });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "failed" },
        { status: 400 },
      );
    }
  },
};
