import type { NextConfig } from 'next';

import withSerwistInit from '@serwist/next';

const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
];

/**
 * remotePatterns entry for the media CDN host, derived from env.
 *
 * Chat IMAGE attachments are rendered with next/image (Option A), and
 * next/image THROWS on an unlisted hostname - so this must match whatever the
 * backend's StorageProvider.publicUrl() produces. Reading the SAME env var the
 * backend uses keeps the two in lockstep and makes an ImageKit -> R2 migration
 * a single env change:
 *
 *   MEDIA_CDN_URL (preferred; set it to the R2 public host when you switch)
 *   IMAGEKIT_URL_ENDPOINT (current provider - used as the fallback)
 *
 * Returns an entry with `pathname` omitted (allow any path) since keys are
 * org-namespaced. Falls back to the known ImageKit host if env is absent, so a
 * missing var cannot silently produce an unlisted-host crash.
 */
function mediaCdnPattern(): NonNullable<NonNullable<NextConfig['images']>['remotePatterns']> {
  const endpoint = process.env.MEDIA_CDN_URL ?? process.env.IMAGEKIT_URL_ENDPOINT ?? 'https://ik.imagekit.io';
  try {
    const url = new URL(endpoint);
    return [
      {
        protocol: url.protocol.replace(':', '') as 'http' | 'https',
        hostname: url.hostname,
      },
    ];
  } catch {
    return [{ protocol: 'https', hostname: 'ik.imagekit.io' }];
  }
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // output: 'standalone',
  // Pages opt into dynamic rendering per-route (see src/app/page.tsx and
  // src/app/not-found.tsx) because the wrapped ThemeProvider from
  // @paalstack/react-ui reads localStorage on mount (theme persistence) and
  // Next 16's static prerender chokes on that. We can opt INTO per-page
  // static rendering once the theme flow is SSR-safe (Phase 2 hardening).

  // Empty turbopack config is required to suppress Next 16's warning that a
  // webpack-style plugin (withSerwistInit) is in use without an explicit
  // turbopack config. The Serwist warning above is the more important signal:
  // `@serwist/next` does not yet support Turbopack (Sep 2026). Production
  // builds still work because Serwist emits the SW via a webpack-style
  // pipeline at build time; the warning is about HMR + SW coexistence in dev.
  // Followed recommendation from Serwist issue serwist/serwist#54.
  turbopack: {},

  transpilePackages: [
    '@paalstack/react-ui',
    '@paalstack/react-hooks',
    '@paalstack/react-icons',
    '@shadhil/ui-tokens',
    '@shadhil/auth',
    // Workspace packages consumed via pnpm symlinks. The prebuild
    // hook in package.json ensures their dist/ is rebuilt before
    // next build runs (Vercel cache + tsc incremental can otherwise
    // leave the symlink target missing, causing TS2307 / Module
    // not found). Keeping these in transpilePackages is also needed
    // for Next 16 App Router server-component transpilation of any
    // files that are pulled into the server bundle.
    '@shadhil/database',
    '@shadhil/api-types',
    '@shadhil/offline-store',
  ],

  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [
      { protocol: 'https', hostname: 'r2.cloudflarestorage.com' },
      // MEDIA (2026-09-18): chat IMAGE attachments are served straight from
      // the storage provider's public CDN (Option A - see
      // apps/backend/src/storage/media-display.ts), so the optimiser needs the
      // host allow-listed. DERIVED FROM ENV deliberately: next/image THROWS
      // ("hostname ... is not configured under images") when it meets an
      // unlisted host, so a hardcoded entry would break the entire chat pane
      // the moment IMAGEKIT_URL_ENDPOINT points at a custom domain. Reading the
      // same variable keeps build config and runtime endpoint in lockstep.
      //
      // WHEN SWITCHING TO CLOUDFLARE R2: point MEDIA_CDN_URL (or
      // IMAGEKIT_URL_ENDPOINT) at the bucket's PUBLIC host -
      // `pub-<hash>.r2.dev`, or your custom domain. Do NOT use the
      // r2.cloudflarestorage.com entry above: that is R2's authenticated S3 API
      // endpoint and browsers cannot fetch from it unauthenticated.
      ...mediaCdnPattern(),
    ],
  },

  // Body cap for chat media uploads (browser sends base64, ~4/3 inflation, so
  // a 10MB file is ~13.4MB on the wire). This is the App Router's supported knob:
  // the old `export const config = { api: { bodyParser } }` route form is
  // deprecated AND SILENTLY IGNORED here (it only logs a warning). The backend
  // must be raised too - each hop caps independently.
  experimental: {
    serverActions: { bodySizeLimit: '25mb' },
  },

  headers: async () => [
    {
      source: '/:path*',
      headers: SECURITY_HEADERS,
    },
    {
      // PWA service worker: must allow control of the entire origin scope,
      // and must never be cached (browsers must re-validate the SW on every
      // page load so updates activate promptly).
      source: '/sw.js',
      headers: [
        { key: 'Service-Worker-Allowed', value: '/' },
        { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
      ],
    },
    // Field-staff photo capture needs camera + geolocation. The rest of
    // the app stays locked-down. Per the plan's Task 14, loosening is
    // scoped to /leads/* and /visits/* (the field-data entry points).
    {
      source: '/leads/:path*',
      headers: [
        { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(self)' },
      ],
    },
    {
      source: '/visits/:path*',
      headers: [
        { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(self)' },
      ],
    },
  ],

  // Proxy NestJS BFF paths to the backend (SSE streams, OpenAPI docs).
  // Sentry, PostHog, and bundle-analyzer wiring are deferred to Phase 2 - they
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

export default withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  // Don't register SW in dev - Turbopack HMR + SW is a known footgun.
  // Production build emits the bundled SW into public/sw.js.
  disable: process.env.NODE_ENV === 'development',
  // Cap precache at 5MB; a single analytics chunk can blow this otherwise.
  maximumFileSizeToCacheInBytes: 5_000_000,
})(nextConfig);


