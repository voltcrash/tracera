import { randomUUID } from "node:crypto";
import type { Plugin } from "vite-plus";

export function resolveBuildId(development: boolean, override = process.env.TRACERA_BUILD_ID) {
  const buildId = override?.trim() || (development ? "dev" : `local-${randomUUID()}`);
  if (!/^[\w.-]{1,64}$/.test(buildId))
    throw new Error("TRACERA_BUILD_ID must be 1-64 letters, digits, . _ or -");
  return buildId;
}

export function buildVersionFile(buildId: string): Plugin {
  const source = JSON.stringify({ version: buildId });
  return {
    name: "tracera-build-version",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/version.json") return next();
        response.setHeader("content-type", "application/json");
        response.setHeader("cache-control", "no-store");
        response.end(source);
      });
    },
  };
}
