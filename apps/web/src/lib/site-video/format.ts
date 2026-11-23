// Duration text for the timer, the tile pill and the tile's accessible name.

/** `m:ss`, rounding to the nearest second. Never negative. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** "Video, 24 seconds": what a screen reader says for a video tile. */
export function videoTileName(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined || durationMs <= 0) return 'Video';
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `Video, ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}
