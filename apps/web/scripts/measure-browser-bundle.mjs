import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const directory = resolve(process.argv[2] ?? fileURLToPath(new URL("../dist", import.meta.url)));
const assets = await readdir(resolve(directory, "client/assets"));
const files = {};
for (const asset of assets.filter((name) => /\.(js|css)$/.test(name)).sort()) {
  const content = await readFile(resolve(directory, "client/assets", asset));
  files[`/assets/${asset}`] = {
    bytes: content.length,
    gzipBytes: gzipSync(content).length,
  };
}

function total(paths) {
  return [...new Set(paths)].reduce(
    (sum, path) => {
      const file = files[path];
      if (!file) throw new Error(`Missing browser asset: ${path}`);
      return { bytes: sum.bytes + file.bytes, gzipBytes: sum.gzipBytes + file.gzipBytes };
    },
    { bytes: 0, gzipBytes: 0 },
  );
}

const serverAssets = await readdir(resolve(directory, "server/assets"));
const manifests = serverAssets.filter(
  (name) => name.startsWith("_tanstack-start-manifest_") && name.endsWith(".js"),
);
if (manifests.length !== 1) throw new Error("Expected one TanStack Start route manifest");
const { tsrStartManifest } = await import(
  pathToFileURL(resolve(directory, "server/assets", manifests[0])).href
);
const { routes } = tsrStartManifest();
const routeJavaScript = {};
for (const [path, matches] of Object.entries({
  "/": ["__root__", "/"],
  "/home": ["__root__", "/_workspace", "/_workspace/home"],
  "/settings": ["__root__", "/_workspace", "/_workspace/settings"],
  "/run/$id": ["__root__", "/_workspace", "/_workspace/run/$id"],
})) {
  routeJavaScript[path] = total(
    matches.flatMap((match) => {
      if (!routes[match]) throw new Error(`Missing route: ${match}`);
      return (routes[match].preloads ?? []).filter((file) => file.endsWith(".js"));
    }),
  );
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      compression: "Sum of individually gzipped files, Node zlib default level 6",
      javaScript: total(Object.keys(files).filter((file) => file.endsWith(".js"))),
      css: total(Object.keys(files).filter((file) => file.endsWith(".css"))),
      routeJavaScript,
      files,
    },
    null,
    2,
  ),
);
