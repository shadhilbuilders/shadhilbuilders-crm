// How long the customer waits between tapping a video tile and seeing the player
// (the device gate's playback number). The tap happens in the feed and the paint
// happens in the lightbox, two components apart, so the moment is carried in a
// module variable rather than threaded through props that exist for nothing else.

let tapAt: number | null = null;

/** Called at the tap, before any state change. */
export function markTileTap(now: number = performance.now()): void {
  tapAt = now;
}

/**
 * The tap to paint interval in whole milliseconds, and it clears the mark so a
 * second read cannot reuse a stale tap.
 */
export function sinceTileTap(now: number = performance.now()): number | null {
  if (tapAt === null) return null;
  const ms = Math.round(now - tapAt);
  tapAt = null;
  return ms < 0 ? null : ms;
}

export function formatPlayerTimings(ms: number | null): string {
  return ms === null ? '' : `open ${ms} ms`;
}
