import type { NextConfig } from 'next';

import withSerwistInit from '@serwist/next';

const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // `camera=(self)` and `microphone=(self)`, NOT `camera=()`: the empty allowlist
  // denies the feature to every origin INCLUDING this one, and the site recorder
  // calls getUserMedia from this origin. Chromium does not enforce the empty
  // allowlist on a top-level document, which is why recording worked in the
  // device gate while the header said it could not; Safari and Firefox do
  // enforce it, so an iPhone would have got a permission error from our own
  // header. `self` is still no cross-origin use.
  {
    key: 'Permissions-Policy',
    value: 'camera=(self), microphone=(self), geolocation=()',
  },
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
  const endpoint =
    process.env.MEDIA_CDN_URL ?? process.env.IMAGEKIT_URL_ENDPOINT ?? 'https://ik.imagekit.io';
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
  // A phone cannot reach localhost, and the camera needs a secure context, so a
  // device check runs against a quick tunnel. Next refuses dev requests whose
  // Host it does not recognise, which answers every route with 404 and looks
  // exactly like a routing bug. Dev only; production builds ignore it.
  allowedDevOrigins: [
    '*.trycloudflare.com',
    '*.ngrok-free.app',
    '*.loca.lt',
    // The phone reaches the dev server through `tailscale serve` (https, real
    // certificate, so getUserMedia works) or straight over the tailnet. Both are
    // dev-only hosts that exist inside this tailnet. Without them Next 16 answers
    // the client's dev requests in a way that leaves the page UNHYDRATED: the
    // login form renders, nothing is clickable, and no request is ever made.
    'laptop-3pl765iv-2.taild43b86.ts.net',
    '100.81.0.50',
  ],
  // REQUIRED by apps/web/Dockerfile: the runner stage copies
  // .next/standalone (self-contained server.js + traced node_modules) and
  // runs `node server.js`. With this commented out the image build dies at
  // the COPY step - .next/standalone is simply never produced. Verified
  // 2026-10-01 (eng review F2). Keep this in lockstep with the Dockerfile.
  output: 'standalone',
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
      headers: [{ key: 'Permissions-Policy', value: 'camera=(self), geolocation=(self)' }],
    },
    {
      source: '/visits/:path*',
      headers: [{ key: 'Permissions-Policy', value: 'camera=(self), geolocation=(self)' }],
    },
    // Site update video: the recorder needs the camera and, when the engineer
    // turns Audio on, the microphone. Scoped to the site routes only; the rest of
    // the app keeps camera=() microphone=(). getUserMedia is still only called
    // when a take starts.
    {
      source: '/:orgSlug/projects/:projectSlug/site/:path*',
      headers: [
        { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
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
  // Inject a build ID into the precache manifest so the SW knows its version.
  // This changes the SW file content on every build, ensuring browsers
  // and CDNs never serve a stale SW. The build ID comes from GITHUB_SHA
  // (CI) or git commit hash (local).
  manifestTransforms: [
    (entries) => ({
      manifest: entries.map((e) => ({
        ...e,
        // Add build ID as revision for the SW entry itself
        // cmda-plan.svg: earlier builds precached the /login redirect HTML under
        // this URL (proxy gated it). Same file hash = same revision = browsers
        // keep the poisoned entry, so salt the revision to force a re-fetch.
        revision:
          e.url === '/sw.js'
            ? (process.env.BUILD_ID ?? 'local')
            : e.url === '/cmda-plan.svg'
              ? `${e.revision ?? ''}-public-v2`
              : e.revision,
      })),
    }),
  ],
})(nextConfig);
