import type { MetadataRoute } from 'next';

/**
 * PWA manifest for shadhil-crm.
 *
 * Next.js file convention: `app/manifest.ts` is auto-served at
 * `/manifest.webmanifest`. Reference it in `app/layout.tsx` via
 * `metadata.manifest = '/manifest.webmanifest'`.
 *
 * Required by Lighthouse PWA category — without this, "Installable"
 * fails and the install prompt never fires on Android Chrome.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Shadhil CRM',
    short_name: 'Shadhil',
    description: 'Real-estate CRM for Shadhil Builders — Lead Inbox, Site Visits, Bookings, Chat, Reminders.',
    // `id` is REQUIRED since Chrome 110+ for installability identity. Do NOT
    // change this on every deploy — bumping it forces the OS to treat the
    // PWA as a new app (loses icon on home screen, breaks existing installs).
    // Bump only when shipping a breaking PWA feature (offline, push, etc).
    id: '/?source=pwa-v1',
    scope: '/',
    start_url: '/?utm_source=pwa',
    display: 'standalone',
    orientation: 'portrait',
    theme_color: '#0f172a',
    background_color: '#f8f5ef',
    categories: ['business', 'productivity'],
    icons: [
      // Real brand icons land in Task 3. These are placeholders so the
      // manifest validates during build; Task 3 replaces them with the
      // real 192/512/maskable-512/apple-touch-180 set.
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/apple-touch-180.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
    ],
  };
}
