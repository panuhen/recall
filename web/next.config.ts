import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Dev runs on Webpack (see package.json) with WATCHPACK_POLLING for reliable
  // HMR over the Windows→Docker bind mount. This also sets the poll interval.
  watchOptions: {
    pollIntervalMs: 500,
  },
};

export default nextConfig;
