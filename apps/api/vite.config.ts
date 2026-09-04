import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/vercel.ts"],
    format: ["esm"],
    platform: "node",
    // The Vercel Function ships as a single file, so nothing may resolve from
    // node_modules at runtime.
    noExternal: [/^[^.]/],
    dts: false,
    treeshake: true,
  },
});
