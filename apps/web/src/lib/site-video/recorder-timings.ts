// Device gate timings, measured where the gate happens: in the browser, on the
// handset, by the code that already knows when each step starts and ends.
//
// Why this exists: the gate table wants recordStartMs, uploadMs, playbackMs and
// clipBytes for every device row. Two of those cannot be read off the server and
// a stopwatch in a person's hand is a guess. This turns all four into numbers the
// recorder takes itself.
//
// Shown only when the URL carries ?timings=1, so a customer never sees it.

export interface TakeTimings {
  /** Tap Record -> the recorder running. Null before a take exists. */
  recordStartMs: number | null;
  /** Tap Use clip -> the server confirmed the saved clip. */
  uploadMs: number | null;
  /** Review opening -> the first frame decoded. */
  playbackMs: number | null;
  /** Length of the clip the browser produced. */
  clipMs: number | null;
  /** Bytes the browser produced, before the server stores them. */
  clipBytes: number | null;
}

export const EMPTY_TIMINGS: TakeTimings = {
  recordStartMs: null,
  uploadMs: null,
  playbackMs: null,
  clipMs: null,
  clipBytes: null,
};

export const TIMINGS_PARAM = 'timings';
const TIMINGS_KEY = 'site-video-timings';

/** True when the page was opened with ?timings=1. Accepts a bare search string. */
export function timingsRequested(
  search: string,
  store: Pick<Storage, 'getItem' | 'setItem'> | null = sessionStore(),
): boolean {
  let asked = false;
  try {
    asked = new URLSearchParams(search).get(TIMINGS_PARAM) === '1';
  } catch {
    // A query string that will not parse is not an ask; `asked` stays false.
  }
  if (asked) {
    // Sticky, because the flag was being lost the moment the recorder was opened
    // from a link that had dropped the query (2026-11-26): the numbers exist to
    // be read afterwards, not to survive a copy-paste of the address bar.
    try {
      store?.setItem(TIMINGS_KEY, '1');
    } catch {
      // A browser that refuses storage still gets the URL form.
    }
    return true;
  }
  try {
    return store?.getItem(TIMINGS_KEY) === '1';
  } catch {
    return false;
  }
}

function sessionStore(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Monotonic where available, so a clock adjustment mid-take cannot fake a number. */
export function stamp(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** Whole milliseconds, never negative, so a reordered call cannot print -3ms. */
export function elapsed(from: number, to: number): number {
  return Math.max(0, Math.round(to - from));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The readout, in the order the gate table reads it. Unmeasured steps are left
 * out rather than printed as zero, so a missing number looks missing.
 */
export function timingLines(t: TakeTimings): string[] {
  const lines: string[] = [];
  if (t.recordStartMs !== null) lines.push(`record start ${formatDuration(t.recordStartMs)}`);
  if (t.uploadMs !== null) lines.push(`save ${formatDuration(t.uploadMs)}`);
  if (t.playbackMs !== null) lines.push(`open ${formatDuration(t.playbackMs)}`);
  if (t.clipBytes !== null) {
    const size = formatBytes(t.clipBytes);
    lines.push(t.clipMs === null ? `clip ${size}` : `clip ${formatDuration(t.clipMs)}, ${size}`);
  }
  return lines;
}
