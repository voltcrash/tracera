/** @type {import('next').NextConfig} */
const nextConfig = {
  // The API route consumes the workspace packages directly from TypeScript.
  transpilePackages: ["@repo/ai", "@repo/db", "@repo/auth", "@repo/contracts"],
};

export default nextConfig;
