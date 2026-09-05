/**
 * @shadhil/ui-tokens — barrel export
 *
 * Single source of truth for Shadhil Builders brand surface
 * (CSS tokens, fonts, compliance helpers, contrast math).
 *
 * T-D8: contrast.ts is the WCAG 2.x contrast computation used by
 * the AA-compliance audit in `compliance.test.ts`. The math is
 * pure (no DOM, no network) so it can be unit-tested and reused
 * across the four surfaces in plan §17.
 */

export * from './compliance';
export * from './contrast';