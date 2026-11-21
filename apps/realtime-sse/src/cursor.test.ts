// Cursor + stream ordering - T-SSE-ANCHOR (2026-11-21).
//
// Pins the fix for a silent data-loss bug in the SSE poll loop. The old code
// advanced its anchor to wall-clock time after each fetch:
//
//     fetcher(lastSeenAt).then(frames => { ...; if (frames.length) lastSeenAt = new Date(); })
//
// A row committed between the query snapshot and that `new Date()` was
// invisible to the query (it ran first) AND older than the new anchor (so the
// next `createdAt > anchor` excluded it). It was lost permanently, with no
// error. The product only felt correct because the web layer polls separately.
//
// These tests assert the invariant that closes it: the cursor may only ever
// move to the ordering tuple of a row that was actually emitted.
import { describe, expect, it } from 'vitest';

import {
  advanceCursor,
  createSeenIds,
  isAfter,
  START_OF_STREAM,
  type CursorFrame,
  type StreamCursor,
} from './cursor.js';

/** Build a frame at a given time; `id` is the tiebreaker within a timestamp. */
function frame(iso: string, id: string): CursorFrame {
  return { id, cursor: { createdAt: new Date(iso), id }, data: { id } };
}

const T1 = '2026-11-21T10:00:00.000Z';
const T2 = '2026-11-21T10:00:05.000Z';
const T3 = '2026-11-21T10:00:10.000Z';

describe('advanceCursor', () => {
  it('does not move when nothing was emitted', () => {
    // THE regression. The old code set the anchor to `new Date()` here
    // whenever the batch was non-empty, and to nothing when empty; either way
    // it never derived the position from data. An empty batch must be a
    // literal no-op, otherwise a quiet tick skips whatever arrived during it.
    const cursor: StreamCursor = { createdAt: new Date(T1), id: 'a' };
    expect(advanceCursor(cursor, [])).toBe(cursor);
  });

  it('moves to the newest emitted row', () => {
    const next = advanceCursor(START_OF_STREAM, [frame(T1, 'a'), frame(T2, 'b')]);
    expect(next).toEqual({ createdAt: new Date(T2), id: 'b' });
  });

  it('never moves backwards, even if a batch arrives out of order', () => {
    // A fetcher that forgot its ORDER BY must not be able to rewind the
    // stream: rewinding would re-emit rows and, worse, re-open a window that
    // has already been skipped past.
    const start: StreamCursor = { createdAt: new Date(T3), id: 'c' };
    const next = advanceCursor(start, [frame(T1, 'a'), frame(T2, 'b')]);
    expect(next).toEqual(start);
  });

  it('takes the maximum across an unordered batch', () => {
    const next = advanceCursor(START_OF_STREAM, [frame(T1, 'a'), frame(T3, 'c'), frame(T2, 'b')]);
    expect(next).toEqual({ createdAt: new Date(T3), id: 'c' });
  });

  it('does not depend on the last element being the newest', () => {
    // "Use the last frame" would truncate here. Taking the max does not.
    const next = advanceCursor(START_OF_STREAM, [frame(T3, 'c'), frame(T1, 'a')]);
    expect(next).toEqual({ createdAt: new Date(T3), id: 'c' });
  });
});

describe('same-timestamp rows (the reason the cursor is a tuple)', () => {
  // `@default(now())` is transaction-start time in Postgres, so a batch of
  // rows written together shares one createdAt. A bare `createdAt >` anchor
  // would drop all but the first of them.
  const shared = T1;

  it('orders same-timestamp rows by id', () => {
    expect(
      isAfter({ createdAt: new Date(shared), id: 'b' }, { createdAt: new Date(shared), id: 'a' }),
    ).toBe(true);
    expect(
      isAfter({ createdAt: new Date(shared), id: 'a' }, { createdAt: new Date(shared), id: 'b' }),
    ).toBe(false);
  });

  it('advances within a shared timestamp instead of stalling', () => {
    // Emitting 'a' then 'b' at the same instant must leave the cursor at 'b',
    // so a page boundary between them resumes correctly.
    const afterA = advanceCursor(START_OF_STREAM, [frame(shared, 'a')]);
    const afterB = advanceCursor(afterA, [frame(shared, 'b')]);

    expect(afterA.id).toBe('a');
    expect(afterB.id).toBe('b');
    expect(afterB.createdAt.getTime()).toBe(new Date(shared).getTime());
  });

  it('does not treat the cursor row as new (strictly-after semantics)', () => {
    const cursor: StreamCursor = { createdAt: new Date(shared), id: 'b' };
    expect(isAfter({ createdAt: new Date(shared), id: 'b' }, cursor)).toBe(false);
  });
});

describe('createSeenIds', () => {
  it('reports a repeat exactly once', () => {
    const seen = createSeenIds(10);
    expect(seen.add('a')).toBe(true);
    expect(seen.add('a')).toBe(false);
  });

  it('evicts oldest entries so memory stays flat', () => {
    const seen = createSeenIds(2);
    seen.add('a');
    seen.add('b');
    seen.add('c'); // evicts 'a'
    expect(seen.add('a')).toBe(true); // forgotten, so treated as new
    expect(seen.add('c')).toBe(false); // still remembered
  });

  it('rejects a nonsensical window rather than silently disabling dedupe', () => {
    expect(() => createSeenIds(0)).toThrow(/positive integer/);
    expect(() => createSeenIds(-1)).toThrow(/positive integer/);
  });
});

describe('the lost-row scenario, end to end', () => {
  // Models the exact interleaving that used to drop a message: a row is
  // committed DURING a fetch. With the tuple cursor the row is still returned
  // by the next call; with the old wall-clock anchor it was gone.
  it('a row committed mid-fetch is still delivered on the next tick', () => {
    // The DB's rows in cursor order. `committed` models which of them exist
    // at a given moment - the point is that a row can appear AFTER a fetch
    // has already started.
    const all = [frame(T1, 'a1'), frame(T2, 'b1'), frame(T3, 'c1')];
    let committed = new Set(['a1']);

    // A fetcher over the currently-committed rows, bounded below by the
    // cursor. Nothing in here reads a clock.
    //
    // `id` is optional on SseFrame (heartbeats omit it); the fetchers always
    // set it, so narrow defensively rather than asserting.
    const fetchAfter = (cursor: StreamCursor): CursorFrame[] =>
      all.filter((f) => f.id !== undefined && committed.has(f.id) && isAfter(f.cursor, cursor));

    let cursor = START_OF_STREAM;

    // Tick 1: only 'a1' exists.
    const tick1 = fetchAfter(cursor);
    cursor = advanceCursor(cursor, tick1);
    expect(tick1.map((f) => f.id)).toEqual(['a1']);

    // Between ticks, 'b1' and 'c1' are committed (the webhook writes two
    // messages, or a customer replies while we are between polls).
    committed = new Set(['a1', 'b1', 'c1']);

    // Tick 2: both new rows are returned. Under the old wall-clock anchor,
    // anything committed before the previous `new Date()` was skipped here.
    const tick2 = fetchAfter(cursor);
    cursor = advanceCursor(cursor, tick2);

    expect(tick2.map((f) => f.id)).toEqual(['b1', 'c1']);

    // And nothing is re-sent on a third tick.
    expect(fetchAfter(cursor)).toEqual([]);
  });

  it('picks up a row committed after the previous boundary timestamp', () => {
    // The sharper version: 'b1' is committed at a time that is AFTER the
    // previous tick's wall clock would have been, but its own createdAt is
    // older than the next tick. A clock-based anchor skips it; a data-based
    // one cannot, because the bound only ever moves to seen rows.
    const cursor: StreamCursor = { createdAt: new Date(T1), id: 'a1' };
    const late = frame('2026-11-21T10:00:01.000Z', 'b1');

    expect(isAfter(late.cursor, cursor)).toBe(true);
    expect(advanceCursor(cursor, [late])).toEqual(late.cursor);
  });
});
