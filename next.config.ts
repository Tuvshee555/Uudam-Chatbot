import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactStrictMode: true,
  // Poster extraction uses these node-only libs on the server; keep them out of
  // the bundle so their dynamic/subpath imports resolve at runtime.
  serverExternalPackages: ["pdf-parse", "mammoth", "pdf-lib", "jpeg-js"],
};

export default nextConfig;
