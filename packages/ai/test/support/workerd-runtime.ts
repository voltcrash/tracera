import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response, type Request } from "miniflare";

export async function createWorkerRuntime(
  upstream: (request: Request) => Promise<Response>,
  addresses: (hostname: string, ipv6: boolean) => string[] = (_hostname, ipv6) => [
    ipv6 ? "2001:4860:4860::8888" : "8.8.8.8",
  ],
) {
  const bundle = await build({
    absWorkingDir: fileURLToPath(new URL("../..", import.meta.url)),
    entryPoints: ["test/support/smoke-worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["browser", "worker", "import"],
    external: ["node:*"],
    metafile: true,
  });
  const requests: string[] = [];
  const runtime = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    r2Buckets: ["BLOBS"],
    outboundService: async (request: Request) => {
      requests.push(request.url);
      const url = new URL(request.url);
      if (url.hostname === "cloudflare-dns.com" || url.hostname === "1.1.1.1") {
        const ipv6 = ["AAAA", "28"].includes(url.searchParams.get("type") ?? "");
        return Response.json({
          Status: 0,
          Question: [{ name: url.searchParams.get("name"), type: ipv6 ? 28 : 1 }],
          Answer: addresses(url.searchParams.get("name")!, ipv6).map((data) => ({
            name: url.searchParams.get("name"),
            type: ipv6 ? 28 : 1,
            data,
            TTL: 60,
          })),
        });
      }
      return upstream(request);
    },
  });
  return { runtime, requests, bundle, dispose: () => runtime.dispose() };
}
