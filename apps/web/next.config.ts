import type { NextConfig } from "next";
import path from "node:path";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin();

const API_URL = process.env.API_URL ?? "http://127.0.0.1:3101";

const nextConfig: NextConfig = {
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
