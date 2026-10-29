import type { NextConfig } from "next";

/**
 * WORKERS_EXPORT=1 → static export for the Cloudflare Worker deployment
 * (API routes live in workers/, not Next). Default → standalone Node build
 * (legacy path, kept so the repo still builds without the flag).
 */
const nextConfig: NextConfig = process.env.WORKERS_EXPORT
  ? {
      output: "export",
      images: { unoptimized: true },
      typescript: { ignoreBuildErrors: true },
      reactStrictMode: false,
    }
  : {
      output: "standalone",
      typescript: { ignoreBuildErrors: true },
      reactStrictMode: false,
    };

export default nextConfig;
