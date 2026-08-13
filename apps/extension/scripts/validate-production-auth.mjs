import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Vite/WXT gives mode-specific files precedence over the generic .env file.
const values = {};
for (const filename of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  const file = resolve(process.cwd(), filename);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

if (values.WXT_TRACERA_API_URL || process.env.WXT_TRACERA_API_URL) {
  console.error(
    "WXT_TRACERA_API_URL is no longer supported. Authentication and API traffic are pinned to https://tracera.voltcrash.com.",
  );
  process.exit(1);
}
