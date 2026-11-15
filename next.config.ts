import type { NextConfig } from "next";

// The admin panel is never framed (clickjacking), indexed or sent as a referrer.
const ADMIN_SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const CATALOGUE_RENDER_FILES = [
  "./public/fonts/*.ttf",
  "./public/poster/uudam-logo.jpg",
  "./node_modules/@sparticuz/chromium/bin/**",
  "./node_modules/playwright-core/browsers.json",
  "./node_modules/playwright-core/package.json",
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/admin", headers: ADMIN_SECURITY_HEADERS },
      { source: "/api/admin/:path*", headers: ADMIN_SECURITY_HEADERS },
    ];
  },
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  // The dev-only "N" badge sat on the admin sidebar's last link ("JSON засвар").
  devIndicators: { position: "bottom-right" },
  // Poster extraction uses these node-only libs on the server; keep them out of
  // the bundle so their dynamic/subpath imports resolve at runtime.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "mammoth", "pdf-lib", "jpeg-js", "@sparticuz/chromium", "playwright-core"],
  outputFileTracingIncludes: {
    // Corporate catalogue renderer (src/lib/catalogue/render): fonts, the repo-approved logo and the
    // headless Chromium it prints with, for every admin route that can render a PDF.
    "/api/admin/catalogue/generate": CATALOGUE_RENDER_FILES,
    "/api/cron/catalogue-refresh": CATALOGUE_RENDER_FILES,
    "/api/admin/catalogue/preview": CATALOGUE_RENDER_FILES,
    "/api/admin/catalogue/preview-sample": CATALOGUE_RENDER_FILES,
    // The readiness checklist only checks that the fonts and the logo exist (no browser is started).
    "/api/admin/catalogue/state": ["./public/fonts/*.ttf", "./public/poster/uudam-logo.jpg"],
    "/api/poster-pdf": [
      "./src/styles/poster.css",
      "./public/fonts/*.ttf",
      "./public/poster/*",
      "./node_modules/@sparticuz/chromium/bin/**",
      "./node_modules/playwright-core/browsers.json",
      "./node_modules/playwright-core/package.json",
    ],
  },
};

export default nextConfig;
