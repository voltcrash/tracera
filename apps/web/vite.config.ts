import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    // build:production selects wrangler.production.json through CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH.
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({ router: { quoteStyle: "double", semicolons: true } }),
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 3000 },
});
