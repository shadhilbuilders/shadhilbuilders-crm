// Regression tests for the BFF backend-path reconstruction.
//
// The bug this pins: a media key containing slashes produced a DOUBLE-SLASH
// backend path (`media//org/id/name.png`), which Nest's single-segment
// `@Get(':key')` route 404s on - so every chat attachment preview broke while
// uploads looked fine. Verified against the running dev server before fixing.
import { describe, expect, it } from 'vitest';

import { buildBackendPath } from './bff-path';

describe('buildBackendPath', () => {
  it('keeps encoded slashes inside a single media-key segment', () => {
    // Next hands the already-decoded key as ONE segment.
    const segments = ['media', '/ceid01lpfe1esm8jwsxid41k28/86a69e29/Hero.jpg'];

    const path = buildBackendPath(segments);

    // The key's slashes stay percent-encoded, so Nest sees ONE :key segment.
    expect(path).toBe(
      'media/%2Fceid01lpfe1esm8jwsxid41k28%2F86a69e29%2FHero.jpg',
    );
    // The regression: a literal leading slash right after the separator.
    expect(path).not.toContain('media//');
  });

  it('keeps genuine path separators between segments', () => {
    expect(buildBackendPath(['leads', 'cmu69ha16', 'transition'])).toBe(
      'leads/cmu69ha16/transition',
    );
  });

  it('round-trips through the backend decode step back to the original key', () => {
    const key = '/org/abc/pic.png';

    const rebuilt = buildBackendPath(['media', key]);
    const encodedKey = rebuilt.slice('media/'.length);

    // MediaController.read() does exactly this decodeURIComponent().
    expect(decodeURIComponent(encodedKey)).toBe(key);
  });

  it('encodes characters that would otherwise break the query/path', () => {
    // A filename with a space, #, ? and unicode must survive the round trip.
    const key = '/org/abc/my file #1?.png';

    const rebuilt = buildBackendPath(['media', key]);
    const encodedKey = rebuilt.slice('media/'.length);

    expect(decodeURIComponent(encodedKey)).toBe(key);
    expect(rebuilt).not.toContain(' ');
    expect(rebuilt).not.toContain('?');
    expect(rebuilt).not.toContain('#');
  });

  it('handles a local-disk key (no leading slash) the same way', () => {
    // LocalDiskStorage returns `org/id/name` without a leading slash.
    const key = 'org1/c74e0a51/pic.png';

    const path = buildBackendPath(['media', key]);

    expect(path).toBe('media/org1%2Fc74e0a51%2Fpic.png');
    expect(path).not.toContain('media//');
  });

  it('returns an empty string for no segments', () => {
    expect(buildBackendPath([])).toBe('');
  });
});
