import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Vite/WXT gives mode-specific files precedence over the generic .env file.
// Read only the one value needed for validation and never print credentials.
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

const publishableKey =
  process.env.WXT_CLERK_PUBLISHABLE_KEY ?? values.WXT_CLERK_PUBLISHABLE_KEY;
const frontendApiUrl =
  process.env.WXT_CLERK_FRONTEND_API_URL ?? values.WXT_CLERK_FRONTEND_API_URL;

if (!publishableKey?.startsWith("pk_live_")) {
  console.error(
    "Production extension builds require WXT_CLERK_PUBLISHABLE_KEY=pk_live_…. " +
      "Use `pnpm build:development` only for an explicitly non-production package.",
  );
  process.exit(1);
}

if (!frontendApiUrl || /\.accounts\.dev(?:\/|$)/i.test(frontendApiUrl)) {
  console.error(
    "Production extension builds require the production WXT_CLERK_FRONTEND_API_URL, not a Clerk accounts.dev host.",
  );
  process.exit(1);
}
