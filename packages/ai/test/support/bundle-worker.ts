import { build } from "esbuild";

export async function bundleTestWorker(contents: string, resolveDir: string) {
  const bundle = await build({
    stdin: { contents, resolveDir, sourcefile: "test-worker.ts", loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "browser", "worker", "import"],
    external: ["node:*", "cloudflare:*"],
    define: { "import.meta.env.DEV": "false", "import.meta.env.MODE": '"test"' },
  });
  return bundle.outputFiles[0]!.text;
}
