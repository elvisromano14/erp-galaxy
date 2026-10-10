import type { NextConfig } from "next";
import path from "node:path";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin();

const API_URL = process.env.API_URL ?? "http://127.0.0.1:3101";

/** Cabeceras de seguridad de la web (la API ya usa helmet). 'unsafe-inline' en scripts/estilos es necesario para el runtime de Next sin nonces. */
const isProd = process.env.NODE_ENV === "production";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=15552000" }] : []),
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Monorepo pnpm: la traza de la salida standalone debe partir de la raíz del workspace.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // La API de NestJS se sirve bajo el mismo origen (sin CORS): /api/v1/* → API. /api/session/* lo atiende Next (BFF).
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${API_URL}/api/v1/:path*` }];
  },
  transpilePackages: ["@erp/domain"],
  webpack(config) {
    config.module.rules.push({
      test: /\.svg$/,
      use: ["@svgr/webpack"],
    });
    return config;
  },
  images: {
    localPatterns: [
      {
        pathname: "/**",
      },
    ],
  },
  turbopack: {
    // Monorepo pnpm: node_modules/next es un symlink a la raíz del workspace.
    root: path.join(__dirname, "../.."),
    rules: {
      "*.svg": {
        loaders: ["@svgr/webpack"],
        as: "*.js",
      },
    },
  },
};

export default withNextIntl(nextConfig);
