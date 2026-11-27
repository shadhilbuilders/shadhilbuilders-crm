// protects=the gate's playback number on the feed lightbox: the wait is the tap to
// the player being on screen, it is measured once per tap, and a stale tap cannot
// be reported twice.
// fails_when=the mark is not cleared after a read, a negative interval is passed
// off as a measurement, or an untapped open reports a number it never observed.
import { describe, expect, it } from 'vitest';

import { formatPlayerTimings, markTileTap, sinceTileTap } from './player-timings';

describe('player timings', () => {
  it('reports the tap to paint interval in whole milliseconds', () => {
    markTileTap(1000);
    expect(sinceTileTap(1076.4)).toBe(76);
  });

  it('clears the mark, so one tap yields one number', () => {
    markTileTap(1000);
    expect(sinceTileTap(1200)).toBe(200);
    expect(sinceTileTap(1300)).toBeNull();
  });

  it('reports nothing when no tile was tapped', () => {
    // A lightbox opened by a deep link never went through the feed.
    expect(sinceTileTap(5000)).toBeNull();
  });

  it('refuses a negative interval instead of showing it as a measurement', () => {
    markTileTap(2000);
    expect(sinceTileTap(1990)).toBeNull();
  });

  it('formats one line for the bar', () => {
    expect(formatPlayerTimings(76)).toBe('open 76 ms');
    expect(formatPlayerTimings(0)).toBe('open 0 ms');
    expect(formatPlayerTimings(null)).toBe('');
  });
});
