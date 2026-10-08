import { describe, expect, it } from 'vitest';

import {
  computeAreaTotal,
  computeNegotiatedTotal,
  computeUnitTotal,
  MAX_RATE_PER_SQFT,
  MAX_SQFT,
} from '../src/pricing';

describe('computeAreaTotal', () => {
  it('multiplies area by rate', () => {
    expect(computeUnitTotal(1450, 4000)).toBe(5_800_000);
    expect(computeNegotiatedTotal(1200, 3900)).toBe(4_680_000);
  });

  it('accepts Decimal strings (Prisma serialisation)', () => {
    expect(computeUnitTotal('1450.00', '4000.00')).toBe(5_800_000);
  });

  it('rounds half-up to 2 decimals without float drift', () => {
    // exact: 1050.1 x 3999.99 = 4,200,389.499 -> 4,200,389.50
    expect(computeAreaTotal(1050.1, 3999.99)).toBe(4_200_389.5);
    expect(computeAreaTotal(0.01, 0.5)).toBe(0.01); // 0.005 rounds up
    expect(computeAreaTotal(0.01, 0.4)).toBe(0); // 0.004 rounds down to 0.00
  });

  it('stays exact at the caps (beyond 2^53 in scaled float math)', () => {
    expect(computeAreaTotal(MAX_SQFT, MAX_RATE_PER_SQFT)).toBe(1_000_000_000_000);
  });

  it.each([
    [null, 100],
    [100, undefined],
    ['', 100],
    [100, '  '],
    [0, 100],
    [100, -5],
    [NaN, 100],
    [Infinity, 100],
    ['abc', 100],
  ])('returns null for unusable input (%s, %s)', (a, b) => {
    expect(computeAreaTotal(a as never, b as never)).toBeNull();
  });
});
