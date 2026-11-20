// Stream cursor - the ordering key that makes SSE delivery lossless.
//
// WHY THIS EXISTS (T-SSE-ANCHOR, 2026-11-21)
// ------------------------------------------
// The poll loop used to advance its "last seen" marker to wall-clock time
// (`lastSeenAt = new Date()`) AFTER the fetch resolved:
//
//     fetcher(lastSeenAt).then(frames => { ...; if (frames.length) lastSeenAt = new Date(); })
//
// Any row committed between the query's snapshot and that `new Date()` was
// invisible to the query (it ran before the row existed) AND older than the
// new anchor (so the next query's `createdAt > lastSeenAt` excluded it).
// The row was skipped permanently - no retry, no error, nothing logged. The
// only reason the product worked was the web layer's independent polling,
// which is a bad thing to lean on silently.
//
// THE FIX: anchor on the DATA, not the clock.
// The cursor is the (createdAt, id) of the newest row actually emitted. The
// next query asks for rows strictly after that tuple, so a row can be
// neither skipped (the bound never moves past unseen data) nor duplicated
// (the bound is inclusive of what was seen only once).
//
// Why (createdAt, id) and not just createdAt: `@default(now())` is
// transaction-start time in Postgres, so several rows commonly share an
// identical timestamp - two messages in one transaction, or two webhook
// events processed together. A bare `createdAt > x` drops every row that
// shares `x`. cuids are monotonic-ish, so the id breaks the tie within a
// timestamp. This matches the order the fetchers already sort by
// (`orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]`), so the DB's order and
// the cursor's order agree - otherwise the window between pages is undefined.
//
// Note on clock sources: `createdAt` comes from the DATABASE, so it is not
// affected by app-server clock skew. That is a second reason not to build
// the anchor from `new Date()` on the app side.

import type { SseFrame } from './stream.js';

/**
 * Position in a channel's stream: the ordering tuple of the newest row that
 * has actually been written to the socket.
 *
 * `createdAt = new Date(0)` / `id = ''` means "start of stream" (a fresh
 * connection with no Last-Event-ID).
 */
export interface StreamCursor {
  createdAt: Date;
  /** Row id at `createdAt`. Empty string only for the start-of-stream cursor. */
  id: string;
}

/** The cursor every stream begins at when there is nothing to resume from. */
export const START_OF_STREAM: StreamCursor = { createdAt: new Date(0), id: '' };

/** A frame that carries the ordering key of the row it represents. */
export interface CursorFrame extends SseFrame {
  /** Ordering tuple for THIS row. Always set by the fetchers. */
  cursor: StreamCursor;
}

/** A channel-specific fetcher: return rows strictly after `cursor`. */
export type Fetcher = (cursor: StreamCursor) => Promise<CursorFrame[]>;

/** True when `a` sorts strictly after `b`. */
export function isAfter(a: StreamCursor, b: StreamCursor): boolean {
  const at = a.createdAt.getTime();
  const bt = b.createdAt.getTime();
  if (at !== bt) return at > bt;
  return a.id > b.id;
}

/**
 * The new cursor after emitting `frames`: the maximum tuple, not the last
 * element.
 *
 * Relying on "last element" would silently truncate the stream if a fetcher
 * ever returned a batch out of order (a future query missing its `orderBy`,
 * say). Taking the max is defensive and costs nothing.
 *
 * Returns `current` unchanged when there are no frames - the anchor must
 * never move without new data to justify it. That single invariant is what
 * closes the lost-row bug.
 */
export function advanceCursor(current: StreamCursor, frames: readonly CursorFrame[]): StreamCursor {
  let next = current;
  for (const frame of frames) {
    if (isAfter(frame.cursor, next)) next = frame.cursor;
  }
  return next;
}

/**
 * Bounded set of recently emitted row ids, used to drop a duplicate frame
 * before it reaches the client (a duplicate renders as a doubled chat bubble,
 * which is worse than the millisecond the check costs).
 *
 * Duplicates should not happen once the cursor is exact and ticks cannot
 * overlap, so this is defence-in-depth against the one remaining path: a
 * fetch that outlives the tick interval. `limit` only needs to exceed the
 * frames a single tick can emit, because the cursor makes anything older
 * unreachable, so a small ring is enough - memory stays flat for the lifetime
 * of a connection.
 */
export interface SeenIds {
  /** Record `id`; true when it was NOT seen before (i.e. emit it). */
  add(id: string): boolean;
}

export function createSeenIds(limit: number): SeenIds {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`createSeenIds: limit must be a positive integer, got ${String(limit)}`);
  }
  // Map preserves insertion order, so the first key is always the oldest -
  // that is what makes FIFO eviction O(1).
  const seen = new Map<string, true>();
  return {
    add(id: string): boolean {
      if (seen.has(id)) return false;
      seen.set(id, true);
      if (seen.size > limit) {
        const oldest = seen.keys().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      return true;
    },
  };
}
