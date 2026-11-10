import type { NextConfig } from "next";

/**
 * Response headers.
 *
 * CSP is the one that matters most here: it is what stops an injected script
 * from reading the page and shipping results somewhere. 'unsafe-inline' for
 * styles is required by the inline style props this UI uses; scripts are not
 * given the same latitude beyond what Next needs for hydration.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // No embedding: the admin panel in an iframe is a clickjacking target.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next injects inline bootstrap scripts; eval is dev-only but harmless
      // to allow since the production build does not use it.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      // QR codes arrive as data: URIs.
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const config: NextConfig = {
  // Do not advertise the framework or its version.
  poweredByHeader: false,
  // Lets a verification build run against its own output directory instead of
  // overwriting the one a dev server is serving from.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: [
    "@prisma/client",
    // Baileys ships protobuf descriptors and native crypto bindings that do
    // not survive bundling; it must be required at runtime.
    "@whiskeysockets/baileys",
  ],
  experimental: {
    serverActions: { bodySizeLimit: "25mb" },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Behind TLS, tell browsers never to try plain http again.
      ...(process.env.NODE_ENV === "production"
        ? [{
            source: "/:path*",
            headers: [{
              key: "Strict-Transport-Security",
              value: "max-age=31536000; includeSubDomains",
            }],
          }]
        : []),
    ];
  },
};

export default config;
