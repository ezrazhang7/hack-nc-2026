import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// Production: `next build` writes the static export to web/out/, which Vercel serves;
// root vercel.json routes /api/* to the Hono API service.
// Development: `next dev` on :3000 proxies /api/* to the local backend so the browser
// sees one origin, matching production. Rewrites are unsupported with output: "export",
// so the two settings are applied in mutually exclusive phases.
export default function nextConfig(phase: string): NextConfig {
  const shared: NextConfig = {
    trailingSlash: true,
    images: { unoptimized: true },
  };

  if (phase === PHASE_DEVELOPMENT_SERVER) {
    const apiTarget = process.env.API_PROXY_TARGET ?? "http://localhost:8787";
    return {
      ...shared,
      async rewrites() {
        return [{ source: "/api/:path*", destination: `${apiTarget}/api/:path*` }];
      },
    };
  }

  return { ...shared, output: "export" };
}
