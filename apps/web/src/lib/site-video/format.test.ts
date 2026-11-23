// formatClock / videoTileName.
// protects= the timer and pill read m:ss, and a tile's name says seconds.
// fails_when= 0:60 appears, a negative shows, or "1 seconds" is spoken.
import { describe, expect, it } from 'vitest';

import { formatClock, videoTileName } from './format';

describe('formatClock', () => {
  it.each([
    [0, '0:00'],
    [24_000, '0:24'],
    [59_600, '1:00'],
    [45_000, '0:45'],
    [-5, '0:00'],
  ])('%d ms is %s', (ms, text) => expect(formatClock(ms)).toBe(text));
});

describe('videoTileName', () => {
  it('names the duration in seconds, singular and plural', () => {
    expect(videoTileName(24_000)).toBe('Video, 24 seconds');
    expect(videoTileName(1_000)).toBe('Video, 1 second');
    expect(videoTileName(400)).toBe('Video, 1 second');
  });
  it('is just "Video" when the duration is unknown', () => {
    expect(videoTileName(null)).toBe('Video');
    expect(videoTileName(undefined)).toBe('Video');
    expect(videoTileName(0)).toBe('Video');
  });
});
