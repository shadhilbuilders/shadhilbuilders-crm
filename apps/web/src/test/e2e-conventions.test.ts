// E2E conventions guard (2026-11-08): the `load`-event trap, enforced.
//
// WHY THIS EXISTS. Every authenticated page in this app keeps an SSE stream
// (`/api/sse/notifications`) open, so the browser's `load` event may never
// fire. Playwright's `page.waitForURL()` / `page.goto()` default to waiting for
// exactly that event, so a bare call waits until its timeout on a navigation
// that has ALREADY SUCCEEDED - and reports it as a broken link or a dead route.
//
// That is not hypothetical. It is written up in three places (`helpers.ts` NAV,
// `visits-show-past-toggle.spec.ts`'s `settled()`, and the comment on
// `plot-layout.spec.ts`'s `waitForURL`), it cost `bookings-approval-audit` a
// whole suite, and it still shipped twice more:
//   - plot-layout.spec.ts:179 - `waitForURL(/\/inventory\?unit=/)`, failed
//     intermittently and passed on retry, the classic load-race signature;
//   - inventory-role-gate.spec.ts (this branch) - the same mistake, written
//     while fixing the first.
//
// A comment cannot fail CI. This does. It reads the spec sources on disk and
// fails if any `waitForURL` / `goto` on an authenticated page omits
// `waitUntil: 'domcontentloaded'` (directly or via `...NAV`).
//
// SCOPE, stated honestly: this is a STATIC scan, not a runtime assertion. It
// catches the shape of the mistake, not its effect. It cannot see a helper that
// wraps waitForURL internally, and it deliberately does not police
// `waitForLoadState` (a `waitForLoadState('domcontentloaded')` retry is legit).
// It also only scans `*.spec.ts` under `src/test/e2e/` - the `.mjs` audit
// harnesses are run by hand, not by the Playwright suite.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const E2E_DIR = join(import.meta.dirname, 'e2e');

/** Every Playwright spec, by filename. */
function specFiles(): string[] {
  return readdirSync(E2E_DIR)
    .filter((name) => name.endsWith('.spec.ts'))
    .sort();
}

/**
 * Extract the full argument text of each `name(` call, paren-balanced.
 *
 * A regex cannot do this: the arguments routinely contain nested calls
 * (`new RegExp(...)`, `expect.stringContaining(...)`) and inline comments, and a
 * lazy `.*?` match would stop at the first inner `)` and then "prove" the
 * `waitUntil` was missing (or present) from the wrong slice.
 */
function callArguments(source: string, name: string): string[] {
  const results: string[] = [];
  const needle = `${name}(`;
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return results;
    let depth = 0;
    let i = at + needle.length - 1;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    results.push(source.slice(at, i + 1));
    from = i + 1;
  }
}

/** Strip `//` line comments so a doc comment cannot satisfy the check. */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * True when the call opts into a non-`load` wait, either explicitly or by
 * deferring to the shared `NAV` options object.
 *
 * `NAV` can arrive two ways and both are legitimate:
 *   page.goto(path, NAV)                 - positional options object
 *   page.waitForURL(re, { ...NAV, t })   - spread, possibly with overrides
 * A plain `\bNAV\b` test would also match `NAV.timeout` inside an unrelated
 * literal, so the positional form must be a STANDALONE argument.
 */
function waitsForDomContentLoaded(args: string): boolean {
  if (/waitUntil\s*:\s*['"]domcontentloaded['"]/.test(args)) return true;
  if (/\.\.\.NAV\b/.test(args)) return true;
  // Standalone positional: `, NAV)` or `(NAV)` - not `NAV.timeout`.
  return /(?:^|[(,]\s*)NAV\s*(?=[),]|$)/.test(args);
}

describe('e2e conventions - never wait for `load` on an authenticated page', () => {
  const files = specFiles();

  it('finds the specs (guards against a path change silently disabling this file)', () => {
    // If the directory moved, `readdirSync` would throw; if the pattern drifted,
    // `files` would be empty and every assertion below would pass vacuously.
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('plot-layout.spec.ts');
  });

  it('every waitForURL passes waitUntil (directly or via ...NAV)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = stripLineComments(readFileSync(join(E2E_DIR, file), 'utf8'));
      for (const call of callArguments(source, 'waitForURL')) {
        if (!waitsForDomContentLoaded(call)) {
          offenders.push(`${file}: ${call.split('\n')[0]?.trim() ?? call}`);
        }
      }
    }
    expect(
      offenders,
      `waitForURL defaults to waiting for \`load\`, which an SSE page never fires:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every page.goto passes waitUntil (directly or via ...NAV)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = stripLineComments(readFileSync(join(E2E_DIR, file), 'utf8'));
      for (const call of callArguments(source, '.goto')) {
        if (!waitsForDomContentLoaded(call)) {
          offenders.push(`${file}: ${call.split('\n')[0]?.trim() ?? call}`);
        }
      }
    }
    expect(
      offenders,
      `page.goto defaults to waiting for \`load\`:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the check actually rejects a bare call (negative control)', () => {
    // Without this, a bug in `callArguments` or the regex could make every
    // assertion above pass while policing nothing.
    expect(waitsForDomContentLoaded('page.waitForURL(/x/, { timeout: 15_000 })')).toBe(false);
    expect(waitsForDomContentLoaded('page.waitForURL(/x/, { ...NAV, timeout: 15_000 })')).toBe(
      true,
    );
    expect(
      waitsForDomContentLoaded("page.waitForURL(/x/, { waitUntil: 'domcontentloaded' })"),
    ).toBe(true);

    // Paren-balancing: a nested call must not truncate the slice.
    const nested = 'await page.waitForURL(new RegExp(`${a}b$`), { ...NAV, timeout: 5 });';
    const [extracted] = callArguments(nested, '.waitForURL');
    expect(extracted).toContain('...NAV');
    expect(extracted).toContain('new RegExp');
  });

  /**
   * The companion trap: overriding NAV's ceiling DOWNWARD.
   *
   * `...NAV, timeout: 15_000` looks harmless and is worse than a bare call,
   * because the spread makes it read as "I handled this". `next dev` compiles a
   * route on first hit and routinely needs more than 15s (measured: 15s for
   * /login, 18s for /plots), and the repo's own config comment says compilation
   * "routinely exceeds Playwright's 30s default". A tighter override turns a
   * slow-but-working navigation into a failure.
   *
   * Rule: navigation waits use NAV's timeout. If a shorter bound is genuinely
   * wanted, it must be justified in a comment AND still be >= the config's
   * `navigationTimeout` ceiling is what the caller needs - so simplest is to
   * just use NAV.
   */
  it('never overrides the navigation ceiling downward', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = stripLineComments(readFileSync(join(E2E_DIR, file), 'utf8'));
      for (const call of [
        ...callArguments(source, 'waitForURL'),
        ...callArguments(source, '.goto'),
      ]) {
        // `...NAV, timeout: <n>` where n is below 45_000.
        for (const match of call.matchAll(/\.\.\.NAV\s*,\s*timeout\s*:\s*([\d_]+)/g)) {
          const value = Number((match[1] ?? '').replace(/_/g, ''));
          if (Number.isFinite(value) && value < 45_000) {
            offenders.push(`${file}: timeout ${value}ms undercuts NAV (45s)`);
          }
        }
      }
    }
    expect(
      offenders,
      `a navigation timeout below the configured ceiling fails on a cold route:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
