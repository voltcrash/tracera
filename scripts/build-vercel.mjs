// Assembles the Vercel Build Output API v3 directory for the single Tracera
// project: the static Next.js export plus one bundled Node.js function that
// serves every `/api/*` route.
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".vercel", "output");
const staticDir = join(output, "static");
const functionDir = join(output, "functions", "api.func");
const webExport = join(root, "apps", "web", "out");
const apiBundle = join(root, "apps", "api", "dist");

/** Every `/hub/<check id>` request is served by this prerendered shell. */
const TRACE_SHELL = "hub/trace";

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(webExport, staticDir, { recursive: true });
await cp(apiBundle, functionDir, { recursive: true });

await writeFile(
  join(functionDir, "package.json"),
  `${JSON.stringify({ type: "module" }, null, 2)}\n`,
);
await writeFile(
  join(functionDir, ".vc-config.json"),
  `${JSON.stringify(
    {
      runtime: "nodejs22.x",
      handler: "vercel.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      maxDuration: 300,
    },
    null,
    2,
  )}\n`,
);

await writeFile(
  join(output, "config.json"),
  `${JSON.stringify(
    {
      version: 3,
      overrides: await cleanUrlOverrides(staticDir),
      routes: [
        // The legacy API subdomain keeps serving the public API at its own
        // root paths; the function restores the shared prefix by host.
        {
          src: "^(?<vpath>/.*)$",
          has: [{ type: "host", value: apiHost() }],
          dest: `/api?__vpath=$vpath`,
        },
        { src: "^(?<vpath>/api(?:/.*)?)$", dest: `/api?__vpath=$vpath` },
        { handle: "filesystem" },
        // Trace pages are client-rendered from one exported shell, including
        // the segment payloads the router fetches on client navigation.
        { src: "^/hub/[^/]+/(?<segment>__next[^/]*)$", dest: `/${TRACE_SHELL}/$segment` },
        { src: "^/hub/[^/]+/?$", dest: `/${TRACE_SHELL}` },
        { handle: "error" },
        { src: "^/.*$", status: 404, dest: "/404.html" },
      ],
    },
    null,
    2,
  )}\n`,
);

console.log(`Vercel build output written to ${relative(root, output)}`);

function apiHost() {
  return process.env.TRACERA_API_HOST ?? "api.tracera.voltcrash.com";
}

/** Serves `about.html` at `/about`, matching the previous deployment's URLs. */
async function cleanUrlOverrides(directory) {
  const overrides = {};
  for (const file of await htmlFiles(directory, "")) {
    if (file === "index.html") continue;
    overrides[file] = {
      path: file.slice(0, -".html".length),
      contentType: "text/html; charset=utf-8",
    };
  }
  return overrides;
}

async function htmlFiles(directory, prefix) {
  const found = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await htmlFiles(directory, path)));
    else if (entry.name.endsWith(".html")) found.push(path);
  }
  return found;
}
