import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Vite/WXT gives mode-specific files precedence over the generic .env file.
const values = {};
for (const filename of [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
]) {
  const file = resolve(process.cwd(), filename);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

const apiUrl =
  process.env.WXT_TRACERA_API_URL ?? values.WXT_TRACERA_API_URL;

if (!apiUrl?.startsWith("https://")) {
  console.error(
    "Production extension builds require an HTTPS WXT_TRACERA_API_URL. " +
      "Use `pnpm build:development` only for an explicitly non-production package.",
  );
  process.exit(1);
}
