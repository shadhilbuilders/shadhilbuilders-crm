// parseRangeHeader / resolveSuffix.
// protects= the forms a <video> sends parse exactly; everything else is ignored
// (full 200) rather than guessed at.
// fails_when= an off-by-one in start/end, a suffix is mistaken for a start, or a
// multi-range / reversed / non-bytes header is half-honoured.
import { describe, expect, it } from 'vitest';

import { parseRangeHeader, resolveSuffix } from './parse-range';

describe('parseRangeHeader', () => {
  it.each([
    ['bytes=0-', { kind: 'range', range: { start: 0 } }],
    ['bytes=10-19', { kind: 'range', range: { start: 10, end: 19 } }],
    ['bytes=5-5', { kind: 'range', range: { start: 5, end: 5 } }],
    ['bytes=-500', { kind: 'suffix', length: 500 }],
    [' bytes=1-2 ', { kind: 'range', range: { start: 1, end: 2 } }],
  ])('parses %s', (header, expected) => {
    expect(parseRangeHeader(header)).toEqual(expected);
  });

  it.each([
    undefined,
    '',
    'bytes=',
    'bytes=-',
    'bytes=-0',
    'bytes=20-10',
    'bytes=0-1,5-6',
    'items=0-1',
    'bytes=a-b',
    'bytes=99999999999999999999-',
  ])('ignores %s', (header) => {
    expect(parseRangeHeader(header)).toEqual({ kind: 'none' });
  });
});

describe('resolveSuffix', () => {
  it('takes the last N bytes', () => expect(resolveSuffix(10, 100)).toEqual({ start: 90 }));
  it('clamps to the whole object when N exceeds it', () =>
    expect(resolveSuffix(500, 100)).toEqual({ start: 0 }));
});
