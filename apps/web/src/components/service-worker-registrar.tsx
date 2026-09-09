'use client';

import { useEffect } from 'react';
import { Serwist } from '@serwist/window';

/**
 * Registers the service worker in both dev and production.
 *
 * Dev: `withSerwistInit({ disable: NODE_ENV === 'development' })` skips SW
 * emission, but `public/sw.js` is still served (from a prior build) and
 * Turbopack dev can register it. Registering in dev is what makes web push
 * testable locally (the push handler lives in sw.js). If sw.js is missing
 * or stale, registration still succeeds and push simply no-ops.
 *
 * `Serwist('/sw.js', { scope: '/' })` matches the public/sw.js emitted by
 * withSerwistInit in next.config.ts. The `Service-Worker-Allowed: /` response
 * header is set on /sw.js in next.config.ts so the SW can claim the entire
 * origin (without it, scope is locked to the SW's directory).
 *
 * The Serwist client class (from @serwist/window) is the 9.x replacement for
 * the manual `navigator.serviceWorker.register()` pattern used in the
 * original plan. It auto-defines `window.serwist` for type-safety.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Skip registration in dev. `next dev` serves a stale public/sw.js
    // from a prior build, and a stale SW can serve cached HTML/JS that
    // fights hot-reload and masks fresh changes. `process.env.NODE_ENV`
    // is inlined by Next.js at build time, so this is a compile-time
    // constant in the client bundle - no runtime cost.
    if (process.env.NODE_ENV === 'development') {
      console.info('[PWA] Service worker disabled in development');
      return;
    }
    if (!('serviceWorker' in navigator)) {
      // Old browser or environment without SW support (e.g. private mode in
      // some Safari versions). Silent no-op - the app still works, it just
      // can't be installed or used offline.
      console.warn('[PWA] navigator.serviceWorker unavailable; PWA features disabled');
      return;
    }

    try {
      const serwist = new Serwist('/sw.js', { scope: '/' });
      void serwist.register();
    } catch (err) {
      // SW registration can fail in restrictive environments (e.g. embedded
      // webviews, strict cookie policies). Don't crash the app - offline +
      // install just become unavailable.
      console.warn('[PWA] Service worker registration failed:', err);
    }
  }, []);

  return null;
}
