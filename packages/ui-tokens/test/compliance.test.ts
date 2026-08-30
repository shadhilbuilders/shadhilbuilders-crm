/**
 * Smoke tests for @shadhil/ui-tokens compliance helpers.
 *
 * We stub the env-resolution layer by setting keys on `globalThis` — that
 * path is exercised by `readEnv` for Next.js inline-env replacement AND
 * for any process-shimmed runtime. (process.env is also covered; vitest
 * provides `process.env` automatically.)
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  formatReraFooter,
  formatComplianceFooter,
  getCmdaInfo,
  getReraInfo,
} from '../src/compliance';

const VALID_ENV = {
  NEXT_PUBLIC_RERA_NUMBER: 'TN/29/2017',
  NEXT_PUBLIC_RERA_VALID_FROM: '2026-01-01',
  NEXT_PUBLIC_RERA_VALID_UNTIL: '2027-12-31',
  NEXT_PUBLIC_CMDA_NUMBER: 'CMDA/2024/0381',
};

function setEnv(values: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) {
      delete process.env[k];
      delete (globalThis as Record<string, unknown>)[k];
    } else {
      process.env[k] = v;
      (globalThis as Record<string, unknown>)[k] = v;
    }
  }
}

beforeEach(() => {
  setEnv(VALID_ENV);
});

afterEach(() => {
  setEnv({
    NEXT_PUBLIC_RERA_NUMBER: undefined,
    NEXT_PUBLIC_RERA_VALID_FROM: undefined,
    NEXT_PUBLIC_RERA_VALID_UNTIL: undefined,
    NEXT_PUBLIC_CMDA_NUMBER: undefined,
  });
});

describe('getReraInfo', () => {
  it('parses a fully-valid env into a typed ReraInfo', () => {
    const info = getReraInfo();
    expect(info).toEqual({
      number: 'TN/29/2017',
      validFrom: '2026-01-01',
      validUntil: '2027-12-31',
    });
  });

  it('throws when the RERA number is missing', () => {
    setEnv({ ...VALID_ENV, NEXT_PUBLIC_RERA_NUMBER: undefined });
    expect(() => getReraInfo()).toThrow();
  });

  it('throws when validFrom is malformed', () => {
    setEnv({ ...VALID_ENV, NEXT_PUBLIC_RERA_VALID_FROM: '01-01-2026' });
    expect(() => getReraInfo()).toThrow();
  });

  it('throws when validFrom is after validUntil', () => {
    setEnv({
      ...VALID_ENV,
      NEXT_PUBLIC_RERA_VALID_FROM: '2028-01-01',
      NEXT_PUBLIC_RERA_VALID_UNTIL: '2027-12-31',
    });
    expect(() => getReraInfo()).toThrow();
  });
});

describe('getCmdaInfo', () => {
  it('parses the CMDA number', () => {
    expect(getCmdaInfo()).toEqual({ number: 'CMDA/2024/0381' });
  });

  it('throws when the CMDA number is missing', () => {
    setEnv({ ...VALID_ENV, NEXT_PUBLIC_CMDA_NUMBER: undefined });
    expect(() => getCmdaInfo()).toThrow();
  });
});

describe('formatReraFooter', () => {
  it('includes the RERA number in the rendered string', () => {
    const out = formatReraFooter();
    expect(out).toContain('TN/29/2017');
    expect(out).toContain('2026-01-01');
    expect(out).toContain('2027-12-31');
    expect(out.startsWith('RERA ')).toBe(true);
  });
});

describe('formatComplianceFooter', () => {
  it('includes both RERA and CMDA numbers', () => {
    const out = formatComplianceFooter();
    expect(out).toContain('TN/29/2017');
    expect(out).toContain('CMDA/2024/0381');
  });
});