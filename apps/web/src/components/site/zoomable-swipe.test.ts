// swipeDirection: when a flick turns the page.
// protects= a clear horizontal flick at 1x navigates, a vertical or short drag
//           does not, and a drag while zoomed is a pan, never a page turn;
// fails_when= a pan at 2x flips the photo; no_claim= pointer wiring.
import { describe, expect, it } from 'vitest';

import { swipeDirection } from './ZoomableImage';

describe('swipeDirection', () => {
  it('left flick = next, right flick = previous', () => {
    expect(swipeDirection(-120, 10, 1)).toBe('next');
    expect(swipeDirection(120, -10, 1)).toBe('previous');
  });
  it('ignores short or mostly-vertical drags', () => {
    expect(swipeDirection(-30, 0, 1)).toBeNull();
    expect(swipeDirection(-100, 90, 1)).toBeNull();
  });
  it('never navigates while zoomed', () => {
    expect(swipeDirection(-200, 0, 2.5)).toBeNull();
  });
});
