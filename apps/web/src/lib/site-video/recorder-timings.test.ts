// recorder-timings: the four numbers the device gate needs, measured in the
// browser instead of guessed with a stopwatch.
//
// protects= ?timings=1 alone turns the readout on, elapsed() never goes negative,
// sizes and durations read the way a person reads them, and an unmeasured step
// is left out rather than printed as zero.
// fails_when= any query string turns the readout on, a reordered call prints a
// negative time, or a missing number shows up as 0 ms.
import { describe, expect, it } from 'vitest';

import {
  EMPTY_TIMINGS,
  elapsed,
  formatBytes,
  formatDuration,
  timingLines,
  timingsRequested,
} from './recorder-timings';

describe('timingsRequested', () => {
  it('turns on for ?timings=1 only', () => {
    // Each check gets a clean store: the flag is sticky by design, so a shared
    // one would carry the first true into the next assertion.
    const fresh = () => new Map<string, string>();
    const store = (map: Map<string, string>) => ({
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    });
    expect(timingsRequested('?timings=1', store(fresh()))).toBe(true);
    expect(timingsRequested('?foo=bar&timings=1', store(fresh()))).toBe(true);
    expect(timingsRequested('', store(fresh()))).toBe(false);
    expect(timingsRequested('?timings=0', store(fresh()))).toBe(false);
    expect(timingsRequested('?timings', store(fresh()))).toBe(false);
    // No storage at all still works off the URL alone.
    expect(timingsRequested('?timings=1', null)).toBe(true);
    expect(timingsRequested('', null)).toBe(false);
  });
});

describe('elapsed', () => {
  it('stays on once seen, so opening the recorder from a bare link keeps it', () => {
    // The bar vanished on the phone because the recorder was opened from a URL
    // that had no query left (2026-11-26).
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(timingsRequested('', fake)).toBe(false);
    expect(timingsRequested('?timings=1', fake)).toBe(true);
    expect(timingsRequested('', fake)).toBe(true);
  });

  it('rounds to whole milliseconds', () => {
    expect(elapsed(100, 412.6)).toBe(313);
  });

  it('never reports a negative time when the calls arrive out of order', () => {
    expect(elapsed(900, 400)).toBe(0);
  });
});

describe('formatting', () => {
  it('reads bytes the way a person does', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(6_301_494)).toBe('6.0 MB');
  });

  it('switches to seconds at one second', () => {
    expect(formatDuration(314)).toBe('314 ms');
    expect(formatDuration(1869)).toBe('1.9 s');
  });
});

describe('timingLines', () => {
  it('prints nothing before a take exists', () => {
    expect(timingLines(EMPTY_TIMINGS)).toEqual([]);
  });

  it('prints the gate numbers in the order the table reads them', () => {
    expect(
      timingLines({
        recordStartMs: 412,
        uploadMs: 3400,
        playbackMs: 890,
        clipMs: 26_156,
        clipBytes: 6_301_494,
      }),
    ).toEqual(['record start 412 ms', 'save 3.4 s', 'open 890 ms', 'clip 26.2 s, 6.0 MB']);
  });

  it('leaves out steps that were not measured, instead of printing zero', () => {
    expect(timingLines({ ...EMPTY_TIMINGS, recordStartMs: 0, clipBytes: 921_009 })).toEqual([
      'record start 0 ms',
      'clip 899.4 KB',
    ]);
  });
});
