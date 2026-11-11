'use client';

// useReveal: fade-up entrance as an element scrolls into view.
//
// Progressive by construction: the server and the first client render show the
// element normally. After mount, ONLY an element that starts below the fold is
// marked `data-reveal="hidden"` (opacity/transform only - see .portal-reveal in
// portal.css) and flipped to "shown" by an IntersectionObserver. Reduced-motion
// users and missing-IntersectionObserver browsers are never hidden.
import { useEffect, useRef, type RefObject } from 'react';

export function shouldDeferReveal({
  top,
  viewportHeight,
  reducedMotion,
}: {
  top: number;
  viewportHeight: number;
  reducedMotion: boolean;
}): boolean {
  return !reducedMotion && top >= viewportHeight;
}

export function useReveal<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof IntersectionObserver === 'undefined') return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const top = el.getBoundingClientRect().top;
    if (!shouldDeferReveal({ top, viewportHeight: window.innerHeight, reducedMotion })) return;

    el.dataset['reveal'] = 'hidden';
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          el.dataset['reveal'] = 'shown';
          observer.disconnect();
        }
      },
      // threshold 0: a tall element (a long phase on a phone) must reveal as soon
      // as ANY of it enters; a ratio threshold could never be met.
      { threshold: 0, rootMargin: '0px 0px -6% 0px' },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      delete el.dataset['reveal'];
    };
  }, []);

  return ref;
}
