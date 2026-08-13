import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    plugins: ["eslint", "typescript", "unicorn", "oxc", "react", "jsx-a11y", "nextjs"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "jsx-a11y/prefer-tag-over-role": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      {
        files: ["**/*.test.ts"],
        rules: { "typescript/no-base-to-string": "off" },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
});
