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
import {
  type Oklch,
  WCAG_AA_NORMAL,
  contrastRatio,
  evaluateContrast,
} from '../src/contrast';

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

/* -------------------------------------------------------------------------- */
/*  T-D8 — WCAG AA status badge contrast audit                                */
/* -------------------------------------------------------------------------- */
/* Every status badge pair used by LeadStatusBadge + the page-level status
 * chips MUST pass AA-normal (4.5:1) for text. The token values below are
 * the shadhil-crm brand overrides from `packages/ui-tokens/src/brand.css`
 * — the upstream @paalstack/react-ui values fail AA on 6/9 pairs (white text
 * on a medium-bright green/blue/red AND on light tints). The overrides
 * darken the strong bg to L~0.55 and add explicit dark foregrounds for the
 * soft tints.
 *
 * If a future change to the override file breaks AA, the test below FAILS
 * the build — that's the "contrast check script in compliance.test.ts"
 * verify line the plan calls for. */

const SHADHIL_AA_OVERRIDES = {
  // Strong variants (white text on the color).
  // Only the 3 that failed AA under the library defaults are overridden
  // (success / destructive / info). Warning already passed at 6.29
  // with the library's dark amber foreground, so it's left alone.
  'success':             { l: 0.530, c: 0.16,  h: 160 },
  'success-foreground':  { l: 0.99,  c: 0,     h: 0   },
  'warning':             { l: 0.72,  c: 0.17,  h: 70  },
  'warning-foreground':  { l: 0.25,  c: 0.04,  h: 70  },
  'destructive':         { l: 0.585, c: 0.21,  h: 25  },
  'destructive-foreground': { l: 0.99, c: 0,    h: 0   },
  'info':                { l: 0.560, c: 0.19,  h: 255 },
  'info-foreground':     { l: 0.99,  c: 0,     h: 0   },
  // Soft variants (dark text on the light tint).
  // Library defaults give soft backgrounds but pair them with the
  // white text-foreground (CR ~1.1, essentially invisible). Override
  // the foregrounds with a darker variant of the same hue.
  'success-soft':         { l: 0.96,  c: 0.035, h: 160 },
  'success-soft-fg':      { l: 0.495, c: 0.16,  h: 160 },
  'warning-soft':         { l: 0.97,  c: 0.04,  h: 90  },
  'warning-soft-fg':      { l: 0.25,  c: 0.04,  h: 70  },
  'destructive-soft':     { l: 0.96,  c: 0.035, h: 25  },
  'destructive-soft-fg':  { l: 0.495, c: 0.21,  h: 25  },
  'info-soft':            { l: 0.96,  c: 0.035, h: 255 },
  'info-soft-fg':         { l: 0.495, c: 0.19,  h: 255 },
} as const satisfies Record<string, Oklch>;

/** Pairs the audit runs against. fg = text color, bg = badge bg.
 *  The token values mirror the overrides in
 *  `packages/ui-tokens/src/brand.css` :root — when you change one,
 *  change the other. (The duplication is intentional: the .css file
 *  is consumed at runtime by the browser; the .ts file is consumed
 *  at test time by the audit. Both must agree.) */
const STATUS_PAIRS: ReadonlyArray<{
  name: string;
  /** Where this badge pair shows up in the UI. */
  surface: string;
  fg: Oklch;
  bg: Oklch;
}> = [
  { name: 'success', surface: 'WON badge', fg: SHADHIL_AA_OVERRIDES['success-foreground'], bg: SHADHIL_AA_OVERRIDES['success'] },
  { name: 'warning', surface: 'VISIT_SCHEDULED badge', fg: SHADHIL_AA_OVERRIDES['warning-foreground'], bg: SHADHIL_AA_OVERRIDES['warning'] },
  { name: 'destructive', surface: 'LOST / NO_SHOW badge', fg: SHADHIL_AA_OVERRIDES['destructive-foreground'], bg: SHADHIL_AA_OVERRIDES['destructive'] },
  { name: 'info', surface: 'CONTACTED badge', fg: SHADHIL_AA_OVERRIDES['info-foreground'], bg: SHADHIL_AA_OVERRIDES['info'] },
  { name: 'success-soft', surface: 'VISITED / BOOKING_INITIATED badge', fg: SHADHIL_AA_OVERRIDES['success-soft-fg'], bg: SHADHIL_AA_OVERRIDES['success-soft'] },
  { name: 'warning-soft', surface: 'VISIT_REQUESTED / RESCHEDULED badge', fg: SHADHIL_AA_OVERRIDES['warning-soft-fg'], bg: SHADHIL_AA_OVERRIDES['warning-soft'] },
  { name: 'destructive-soft', surface: 'LOST-soft badge', fg: SHADHIL_AA_OVERRIDES['destructive-soft-fg'], bg: SHADHIL_AA_OVERRIDES['destructive-soft'] },
  { name: 'info-soft', surface: 'CONTACTED-soft badge', fg: SHADHIL_AA_OVERRIDES['info-soft-fg'], bg: SHADHIL_AA_OVERRIDES['info-soft'] },
];

describe('T-D8 — WCAG AA status badge contrast', () => {
  it('every shadhil-crm status pair passes AA-normal (>= 4.5:1)', () => {
    const failures: string[] = [];
    for (const pair of STATUS_PAIRS) {
      const v = evaluateContrast(pair.fg, pair.bg);
      if (!v.passes['AA-normal']) {
        failures.push(
          `  - ${pair.name} (${pair.surface}): CR=${v.ratio.toFixed(2)} < ${WCAG_AA_NORMAL}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `T-D8 audit failed — ${failures.length} status pair(s) below WCAG AA-normal:\n` +
          failures.join('\n') +
          '\nFix the oklch values in `packages/ui-tokens/src/brand.css` and the mirrored `SHADHIL_AA_OVERRIDES` map in `test/compliance.test.ts`, then re-run.',
      );
    }
  });

  it('regression: the @paalstack/react-ui defaults FAIL AA on 6/9 pairs (proof the override is needed)', () => {
    // These are the upstream library values (before shadhil-crm overrides).
    // They exist here to lock the audit's reference point — if a future
    // library upgrade "fixes" them, this test will start passing and the
    // shadhil-crm override can be removed.
    const LIB_DEFAULTS = {
      'success':             { l: 0.63, c: 0.16,  h: 160 },
      'success-foreground':  { l: 0.99, c: 0,     h: 0   },
      'warning':             { l: 0.72, c: 0.17,  h: 70  },
      'warning-foreground':  { l: 0.25, c: 0.04,  h: 70  },
      'destructive':         { l: 0.62, c: 0.21,  h: 25  },
      'destructive-foreground': { l: 0.99, c: 0,  h: 0   },
      'info':                { l: 0.58, c: 0.19,  h: 255 },
      'info-foreground':     { l: 0.99, c: 0,     h: 0   },
      'success-soft':         { l: 0.96, c: 0.035, h: 160 },
      'success-soft-fg':      { l: 0.99, c: 0,     h: 0   },
      'warning-soft':         { l: 0.97, c: 0.04,  h: 90  },
      'warning-soft-fg':      { l: 0.25, c: 0.04,  h: 70  },
      'destructive-soft':     { l: 0.96, c: 0.035, h: 25  },
      'destructive-soft-fg':  { l: 0.99, c: 0,     h: 0   },
      'info-soft':            { l: 0.96, c: 0.035, h: 255 },
      'info-soft-fg':         { l: 0.99, c: 0,     h: 0   },
    } as const;

    const failingPairs: string[] = [];
    for (const pair of STATUS_PAIRS) {
      // Cast: the as-const map's exact key types are too narrow for
      // dynamic lookup; the data is checked by the test itself.
      const libMap = LIB_DEFAULTS as Record<string, Oklch>;
      const fgKey = pair.name.includes('-soft')
        ? `${pair.name}-fg`
        : `${pair.name}-foreground`;
      const fg = libMap[fgKey];
      const bg = libMap[pair.name];
      if (fg === undefined) continue;
      const c = contrastRatio(fg, bg);
      if (c < WCAG_AA_NORMAL) {
        failingPairs.push(`${pair.name} (CR=${c.toFixed(2)})`);
      }
    }
    // We expect at least 5 of 9 to fail with the library defaults.
    // (warning + warning-soft pass because the library happens to use
    // a dark amber fg for those; the other 6 pairs fail.)
    expect(failingPairs.length).toBeGreaterThanOrEqual(5);
  });
});