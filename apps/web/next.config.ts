import type { NextConfig } from 'next';

const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Pages opt into dynamic rendering per-route (see src/app/page.tsx and
  // src/app/not-found.tsx) because the wrapped ThemeProvider from
  // @paalstack/react-ui reads localStorage on mount (theme persistence) and
  // Next 16's static prerender chokes on that. We can opt INTO per-page
  // static rendering once the theme flow is SSR-safe (Phase 2 hardening).

  transpilePackages: [
    '@paalstack/react-ui',
    '@paalstack/react-hooks',
    '@paalstack/react-icons',
    '@shadhil/ui-tokens',
    '@shadhil/auth',
  ],

  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [{ protocol: 'https', hostname: 'r2.cloudflarestorage.com' }],
  },

  experimental: {
    serverActions: { bodySizeLimit: '2mb' },
  },

  headers: async () => [{ source: '/:path*', headers: SECURITY_HEADERS }],

  // Proxy NestJS BFF paths to the backend (SSE streams, OpenAPI docs).
  // Sentry, PostHog, and bundle-analyzer wiring are deferred to Phase 2 — they
  // were stripped with the starter boilerplate; bring them back when needed.
  skipTrailingSlashRedirect: true,
  rewrites: async () => [
    {
      source: '/api/backend/:path*',
      destination: `${process.env.BACKEND_API_URL ?? 'http://localhost:8080'}/:path*`,
    },
    {
      source: '/api/docs',
      destination: `${process.env.BACKEND_API_URL ?? 'http://localhost:8080'}/api/docs`,
    },
  ],
};

export default nextConfig;
