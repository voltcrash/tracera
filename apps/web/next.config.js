/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Vercel deployment serves this app as static files next to a single
  // Node.js function that owns every `/api/*` route.
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
