import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const rootEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnvPath)) loadEnvFile(rootEnvPath);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The API route consumes the workspace packages directly from TypeScript.
  transpilePackages: ["@repo/ai", "@repo/db", "@repo/auth", "@repo/contracts"],
};

export default nextConfig;
