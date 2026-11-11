// use-reveal decision helper.
// protects= content already on screen (or any reduced-motion user) is never
//           hidden for an entrance animation, so SSR/above-the-fold content
//           cannot flash or stay invisible;
// fails_when= an on-screen element is deferred, or reduced motion still hides;
// no_claim= IntersectionObserver wiring (needs a browser; covered by the
//           Playwright pass).
import { describe, expect, it } from 'vitest';

import { shouldDeferReveal } from './use-reveal';

describe('shouldDeferReveal', () => {
  it('defers only elements that start below the fold', () => {
    expect(shouldDeferReveal({ top: 900, viewportHeight: 700, reducedMotion: false })).toBe(true);
  });
  it('never defers an element already in view', () => {
    expect(shouldDeferReveal({ top: 120, viewportHeight: 700, reducedMotion: false })).toBe(false);
    expect(shouldDeferReveal({ top: -300, viewportHeight: 700, reducedMotion: false })).toBe(false);
  });
  it('never defers for reduced motion', () => {
    expect(shouldDeferReveal({ top: 900, viewportHeight: 700, reducedMotion: true })).toBe(false);
  });
});
