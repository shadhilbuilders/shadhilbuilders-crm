'use client';

import { useEffect } from 'react';
import { Serwist } from '@serwist/window';

/**
 * Registers the service worker in production. Skipped in dev because:
 *   1. `withSerwistInit({ disable: NODE_ENV === 'development' })` skips SW emission.
 *   2. Turbopack dev doesn't bundle Serwist (serwist/serwist#54).
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
    // Early-return is the only NODE_ENV check; the rest of the effect runs
    // in the browser, where process.env.NODE_ENV is undefined-typed. Webpack
    // inlines the literal at build time.
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) {
      // Old browser or environment without SW support (e.g. private mode in
      // some Safari versions). Silent no-op — the app still works, it just
      // can't be installed or used offline.
      console.warn('[PWA] navigator.serviceWorker unavailable; PWA features disabled');
      return;
    }

    try {
      const serwist = new Serwist('/sw.js', { scope: '/' });
      void serwist.register();
    } catch (err) {
      // SW registration can fail in restrictive environments (e.g. embedded
      // webviews, strict cookie policies). Don't crash the app — offline +
      // install just become unavailable.
      console.warn('[PWA] Service worker registration failed:', err);
    }
  }, []);

  return null;
}
