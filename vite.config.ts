import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    plugins: ["eslint", "typescript", "unicorn", "oxc", "react", "jsx-a11y"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "jsx-a11y/prefer-tag-over-role": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      {
        files: ["apps/web/src/app/**", "apps/web/src/proxy.ts"],
        plugins: ["nextjs"],
      },
      {
        files: ["**/*.test.ts"],
        rules: { "typescript/no-base-to-string": "off" },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./apps/web/test/support/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
});
