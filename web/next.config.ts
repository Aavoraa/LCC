import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Pin the root to this folder; a stray package-lock.json higher up would otherwise be picked.
  turbopack: { root: __dirname },
  outputFileTracingRoot: __dirname,
  // Short links people type on a phone: the phone experience is the same site, starting at the scanner.
  async redirects() {
    return [
      { source: "/m", destination: "/scan", permanent: false },
      { source: "/mobile", destination: "/scan", permanent: false },
      { source: "/app", destination: "/scan", permanent: false },
    ];
  },
};

export default nextConfig;
