'use client';

import { useEffect, useState } from 'react';

/**
 * Top-of-`<main>` progress bar that appears for 800ms whenever the
 * browser fires the `online` event (per design review D6). The bar
 * itself is purely visual; the actual data refresh is handled by
 * TanStack Query's `refetchOnReconnect: true` (already on per
 * `apps/web/src/lib/query-client/lib.ts:33`).
 *
 * Animation: `transform: scaleX(0) → scaleX(1)` with
 * `transform-origin: left`. GPU-only (compositor thread, no layout
 * thrash). `prefers-reduced-motion: reduce` disables the transition
 * via the `motion-reduce:transition-none` utility.
 */
export const OnlineRevalidationBar = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onOnline = () => {
      setVisible(true);
      timer = setTimeout(() => setVisible(false), 800);
    };
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      clearTimeout(timer);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      data-testid="online-revalidation-bar"
      role="status"
      aria-live="polite"
      className="motion-reduce:transition-none bg-primary fixed top-0 right-0 left-0 z-50 h-0.5 transition-opacity"
      style={{ animation: 'shadhil-progress 800ms ease-out forwards' }}
    />
  );
};
