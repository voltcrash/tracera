/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;

// Makes `next dev` expose the Cloudflare-compatible bindings expected by
// OpenNext while production builds continue to use the standard Next config.
void import("@opennextjs/cloudflare").then((module) => module.initOpenNextCloudflareForDev());
