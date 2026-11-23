// HTTP Range header parsing for media reads (site update video, step 6).
//
// Only the single-range `bytes=` forms a <video> element sends are honoured.
// Anything else (multiple ranges, another unit, garbage) is "ignore the header":
// RFC 9110 lets a server answer 200 with the full body, which is always safe.
import type { ByteRange } from './storage.provider';

export type ParsedRange =
  | { kind: 'none' }
  | { kind: 'range'; range: ByteRange }
  /** `bytes=-N`: the last N bytes, which needs the object size to resolve. */
  | { kind: 'suffix'; length: number };

const NONE: ParsedRange = { kind: 'none' };
const SINGLE = /^bytes=(\d*)-(\d*)$/;

export function parseRangeHeader(header: string | undefined): ParsedRange {
  if (header === undefined) return NONE;
  const match = SINGLE.exec(header.trim());
  if (match === null) return NONE;
  const [, from = '', to = ''] = match;
  if (from === '' && to === '') return NONE;
  if (from === '') {
    const length = Number(to);
    return Number.isSafeInteger(length) && length > 0 ? { kind: 'suffix', length } : NONE;
  }
  const start = Number(from);
  if (!Number.isSafeInteger(start)) return NONE;
  if (to === '') return { kind: 'range', range: { start } };
  const end = Number(to);
  // end < start is invalid syntax per RFC: ignore the header.
  return Number.isSafeInteger(end) && end >= start
    ? { kind: 'range', range: { start, end } }
    : NONE;
}

/** Resolve a suffix range against the real object size. */
export function resolveSuffix(length: number, size: number): ByteRange {
  return { start: Math.max(size - length, 0) };
}
