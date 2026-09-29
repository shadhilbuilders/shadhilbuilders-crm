// KPI tone audit - REAL browser, REAL computed colours (2026-09-29).
//
// WHY THIS EXISTS: jsdom's axe `color-contrast` rule is a silent no-op (no
// canvas), so a green vitest run says nothing about contrast - this repo has
// already been burned by exactly that (see dashboard-audit.spec.ts). The tone
// classes are pinned cheaply in vitest; the COMPUTED colour on a TINTED card is
// only knowable from a browser, so it is measured here.
//
// It asserts the specific trap this change had to avoid: `text-muted-foreground`
// clears AA on the plain white card (4.75:1) but only reaches 4.09-4.37:1 ON the
// soft tints, so the label/sub must resolve to a full-strength foreground on
// every tinted card. Measured light/dark, the four tones come out as:
//
//   light  label 16.2-18.4:1   icon  4.0-16.2:1   (muted WOULD be 3.8-4.4:1)
//   dark   label  8.5-15.7:1   icon  5.2-15.7:1
//
// TWO IMPLEMENTATION NOTES, both learned the hard way:
//   1. Colours are read by PAINTING them onto a canvas and sampling the pixel.
//      Chrome reports computed colours as `oklch(...)` for these tokens, so a
//      regex over `rgb(...)` silently yields null - which reads as "no data"
//      and would make a broken assertion look like a passing one.
//   2. Dark mode is probed via the live theme TOGGLE, not by setting a class.
//      `next-themes` rehydrates the root element and strips an externally-set
//      `dark` class, so a forced class silently measures the light tokens twice.
//
// RUN:  npx playwright test src/test/e2e/kpi-tone-audit.spec.ts --project=chromium --reporter=list
// REQS: dev servers up (web :3000, backend :8080) + the seeded demo user
//       (`pnpm --filter @shadhil/database setup:demo-user`). Without that user
//       the login helper times out and both tests fail - a setup gap, not a
//       colour regression.
import { createRequire } from 'node:module';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const REQUIRE = createRequire(import.meta.url);
const AXE_PATH = REQUIRE.resolve('axe-core/axe.min.js');

const DEMO_EMAIL = 'demo@shadhilbuilders.in';
const DEMO_PASSWORD = 'demo123';
const DASHBOARD = '/demo/projects/demo-villas/dashboard';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('input#email, input[name="email"]').fill(DEMO_EMAIL);
  await page.locator('[data-qa="login-password"]').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
}

type CardReport = {
  label: string;
  cardBg: string;
  labelCr: number;
  valueCr: number;
  iconCr: number;
  iconCount: number;
  hiddenIconCount: number;
  /** True when the label resolved to the muted token - must never happen. */
  labelIsMuted: boolean;
};

/**
 * Measures each KPI card's real painted colours and returns WCAG ratios.
 * `mutedHex` is the resolved `--muted-foreground` in the CURRENT mode, so the
 * "did the muted token leak onto a tint?" check works in dark mode too (where
 * the value is near-white, not #64748b).
 */
type Rgb3 = [number, number, number];
type Rgb4 = [number, number, number, number];

async function measure(page: Page, mutedHex: string): Promise<CardReport[]> {
  return page.evaluate((muted) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const maybeCtx = canvas.getContext('2d');
    if (maybeCtx === null) throw new Error('2d canvas context unavailable');
    const ctx: CanvasRenderingContext2D = maybeCtx;

    /** Paint a CSS colour and read the real sRGB pixel back (oklch-safe). */
    function toRgb(css: string): Rgb4 {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255];
    }
    /** Composite a possibly-translucent foreground over an opaque background. */
    function over(fg: Rgb4, bg: Rgb3): Rgb3 {
      const a = fg[3];
      return [
        fg[0] * a + bg[0] * (1 - a),
        fg[1] * a + bg[1] * (1 - a),
        fg[2] * a + bg[2] * (1 - a),
      ];
    }
    function hex(rgb: Rgb3): string {
      return '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
    }
    function lum(rgb: Rgb3): number {
      const f = (c: number) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
    }
    function cr(a: Rgb3, b: Rgb3): number {
      const la = lum(a);
      const lb = lum(b);
      const hi = Math.max(la, lb);
      const lo = Math.min(la, lb);
      return (hi + 0.05) / (lo + 0.05);
    }

    const cards = Array.from(
      document.querySelectorAll('[data-qa^="kpi-filter-"], [data-qa="kpi-card-static"]'),
    );
    return cards.map((el) => {
      const cs = getComputedStyle(el);
      // A KPI card is opaque, so its painted background IS its computed one.
      const bg = toRgb(cs.backgroundColor);
      const bgOpaque = over(bg, [255, 255, 255]);

      const spans = Array.from(el.querySelectorAll('span'));
      const labelSpan = spans.find((s) => s.className.includes('uppercase'));
      const valueSpan = spans.find((s) => s.dataset.state !== undefined);
      const svgs = Array.from(el.querySelectorAll('svg'));

      const labelRaw = toRgb(labelSpan ? getComputedStyle(labelSpan).color : cs.color);
      const valueRaw = toRgb(valueSpan ? getComputedStyle(valueSpan).color : cs.color);
      const iconRaw = svgs[0] ? toRgb(getComputedStyle(svgs[0]).color) : null;

      const label = over(labelRaw, bgOpaque);
      const value = over(valueRaw, bgOpaque);
      return {
        label: (labelSpan?.textContent ?? '').trim(),
        cardBg: hex(bgOpaque),
        labelCr: +cr(label, bgOpaque).toFixed(2),
        valueCr: +cr(value, bgOpaque).toFixed(2),
        iconCr: iconRaw ? +cr(over(iconRaw, bgOpaque), bgOpaque).toFixed(2) : 0,
        iconCount: svgs.length,
        hiddenIconCount: svgs.filter((s) => s.getAttribute('aria-hidden') === 'true').length,
        labelIsMuted: hex(label) === muted,
      };
    });
  }, mutedHex);
}

/** Resolves `--muted-foreground` to a hex in the CURRENT mode. */
async function mutedHex(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const maybeCtx2 = canvas.getContext('2d');
    if (maybeCtx2 === null) throw new Error('2d canvas context unavailable');
    const ctx2: CanvasRenderingContext2D = maybeCtx2;
    const probe = document.createElement('div');
    probe.className = 'text-muted-foreground';
    probe.textContent = 'x';
    document.body.appendChild(probe);
    ctx2.fillStyle = '#000';
    ctx2.fillStyle = getComputedStyle(probe).color;
    ctx2.fillRect(0, 0, 1, 1);
    const d = ctx2.getImageData(0, 0, 1, 1).data;
    probe.remove();
    return (
      '#' +
      [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0].map((c) => c.toString(16).padStart(2, '0')).join('')
    );
  });
}

/** Flips the app's own theme control so `next-themes` owns the state. */
async function setTheme(page: Page, mode: 'light' | 'dark'): Promise<void> {
  const current = await page.evaluate(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  );
  if (current === mode) return;
  const toggle = page.getByRole('button', { name: /switch to (dark|light) mode/i }).first();
  if ((await toggle.count()) > 0) {
    await toggle.click();
    await page.waitForTimeout(200);
  }
  // Fail loudly rather than silently measuring the same mode twice.
  const now = await page.evaluate(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  );
  expect(now, `could not switch the app into ${mode} mode`).toBe(mode);
}

test('KPI cards are tinted, iconned, and clear AA on their own tint (light + dark)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(DASHBOARD);
  await page.waitForSelector('[data-qa^="kpi-"]');

  for (const mode of ['light', 'dark'] as const) {
    await setTheme(page, mode);
    const muted = await mutedHex(page);
    const report = await measure(page, muted);

    console.log(`\n=== KPI card tone audit - ${mode} (muted resolves to ${muted}) ===`);
    for (const c of report) {
      console.log(
        `${c.label.padEnd(18)} bg=${c.cardBg} label=${String(c.labelCr).padStart(6)}:1 ` +
          `value=${String(c.valueCr).padStart(6)}:1 icon=${String(c.iconCr).padStart(6)}:1 ` +
          `icons=${c.iconCount} (aria-hidden ${c.hiddenIconCount})`,
      );
    }

    // Four cards on the work dashboard.
    expect(report.length, `${mode}: expected four KPI cards`).toBe(4);

    for (const c of report) {
      // 1. Every card is tinted - not the plain card surface.
      expect(c.cardBg, `${mode}/${c.label}: card is not tinted`).not.toBe('#ffffff');
      expect(c.cardBg, `${mode}/${c.label}: card is not tinted`).not.toBe('#020817');
      // 2. Every card carries exactly one decorative icon.
      expect(c.iconCount, `${mode}/${c.label}: expected 1 icon`).toBe(1);
      expect(c.hiddenIconCount, `${mode}/${c.label}: icon is not aria-hidden`).toBe(1);
      // 3. Text clears AA on its own tint - the whole point of this file.
      expect(c.labelCr, `${mode}/${c.label}: label contrast`).toBeGreaterThanOrEqual(4.5);
      expect(c.valueCr, `${mode}/${c.label}: value contrast`).toBeGreaterThanOrEqual(4.5);
      // 4. The muted token must NEVER be the label colour on a tinted card.
      expect(c.labelIsMuted, `${mode}/${c.label}: label used the muted token`).toBe(false);
      // The icon is a graphical object, so 3:1 (AA non-text) is its floor.
      expect(c.iconCr, `${mode}/${c.label}: icon contrast`).toBeGreaterThanOrEqual(3.0);
    }
  }
});

test('KPI cards raise no axe violations (including the colour rule jsdom cannot run)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await login(page);
  await page.goto(DASHBOARD);
  await page.waitForSelector('[data-qa^="kpi-"]');
  await page.addScriptTag({ path: AXE_PATH });

  const results = await page.evaluate(async () => {
    const axe = (
      window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<unknown> } }
    ).axe;
    // Scoped to the counts region: the rest of the dashboard has its own audit
    // (dashboard-audit.spec.ts) and its own known out-of-scope failures.
    const ctx = document.querySelector('[aria-label="Work counts"]');
    return (await axe.run(ctx ?? document, {
      runOnly: ['color-contrast', 'svg-img-alt', 'button-name', 'aria-allowed-attr'],
    })) as { violations: Array<{ id: string; nodes: unknown[] }> };
  });

  console.log(
    'axe (KPI counts region):',
    results.violations.length === 0
      ? 'clean'
      : results.violations.map((v) => `${v.id} x${v.nodes.length}`).join(', '),
  );
  expect(results.violations).toEqual([]);
});
