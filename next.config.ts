import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    browserDebugInfoInTerminal: true,
    globalNotFound: true,
    clientSegmentCache: true,
    turbopackPersistentCaching: true,
    cacheComponents: true,
  },
};

export default nextConfig;
