// Plot layout e2e - the interactive CMDA plot map.
//
// This is the spec that proves the feature WORKS IN A BROWSER, which is the
// only evidence that counts for a change to what a page renders. The unit suite
// already pins the geometry and the merge rules; this file covers what only a
// real browser can: that the traced polygons line up with the artwork, that a
// click selects the plot under the cursor rather than a neighbour, and that
// zoom/pan survive the interaction.
//
// Loaded with the shared demo storageState from playwright.config.ts, so the
// session comes from auth.setup - never a sign-in inside a spec.
//
// Never wait for `load`/`networkidle` on an authenticated page: the app shell
// keeps an SSE stream open, so those events never fire and the timeout reads
// like a product bug. `domcontentloaded` is enough.
//
// AVAILABILITY COMES FROM THE API in these tests: the map reads
// GET /api/bff/inventory/plots, which the CI e2e job serves from a real backend
// (it polls :8080/api/health before running Playwright). Locally that means the
// backend must be up too, or the page renders its error state - which is the
// correct behaviour, and one of the tests below asserts it.

import { expect, test } from '@playwright/test';

import { NAV } from './helpers';

const PLOTS_PATH = '/demo/projects/demo-villas/plots';

/** Wait for React to own the map, not just for the markup to arrive. */
async function waitForMapToHydrate(page: import('@playwright/test').Page) {
  await page.waitForFunction(
    () => {
      const svg = document.querySelector('[data-qa="plot-map"]');
      if (!(svg instanceof SVGElement)) return false;
      return Object.keys(svg).some((key) => key.startsWith('__react'));
    },
    { timeout: 15_000 }
  );
}

/** Parse an SVG viewBox attribute into four numbers. */
function parseViewBox(value: string | null): [number, number, number, number] {
  const parts = (value ?? '').split(' ').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`unparseable viewBox: ${String(value)}`);
  }
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

test.describe('plot layout', () => {
  test('renders the traced layout with the artwork and all 125 plots', async ({ page }) => {
    await page.goto(PLOTS_PATH, NAV);
    await waitForMapToHydrate(page);

    // Every plot on the drawing is an independent hit area.
    await expect(page.locator('[data-qa="plot-polygon"]')).toHaveCount(125);

    // The background is the real site plan, sharing the map's coordinate space.
    const artwork = page.locator('[data-qa="plot-map-background"] image');
    await expect(artwork).toHaveAttribute('href', '/cmda-plan.svg');
    const viewBox = await page.locator('[data-qa="plot-map"]').getAttribute('viewBox');
    expect(viewBox?.startsWith('99.1 108.8')).toBe(true);

    // The legend names every state and totals the layout.
    const legend = page.locator('[data-qa="plot-legend"]');
    await expect(legend).toContainText('Available');
    await expect(legend).toContainText('Booked');
    await expect(legend).toContainText('Selected');
    await expect(legend).toContainText('125 plots');

    // And the surface is reachable: the sidebar links to this project's layout.
    await expect(page.locator('a[href$="/plots"]').first()).toBeVisible();
  });

  test('reads plot availability from the API, and explains an all-available result', async ({
    page,
  }) => {
    // Assert the request the map actually depends on, so a future regression to
    // baked-in data fails here rather than passing on a stale constant.
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/api/bff/inventory/plots') && response.status() === 200,
      { timeout: 30_000 }
    );
    await page.goto(PLOTS_PATH, NAV);
    const response = await responsePromise;
    await waitForMapToHydrate(page);

    // The endpoint answers with a row set (possibly empty). An empty set is a
    // real answer: no unit in this project is numbered by plot number.
    const body = (await response.json()) as { rows: unknown[] };
    expect(Array.isArray(body.rows)).toBe(true);

    if (body.rows.length === 0) {
      // Nothing is plot-numbered, so everything must read available and the page
      // must SAY why - an entirely grey plan with no explanation reads as a bug.
      await expect(page.locator('[data-qa="plot-no-unit-mapping"]')).toContainText(
        'numbered by plot'
      );
      expect(await page.locator('[data-plot-number="1"] polygon[fill="#9CA3AF"]').count()).toBe(1);
      expect(await page.locator('polygon[fill="#16A34A"]').count()).toBe(0);
      await expect(page.locator('[data-qa="plot-legend"]')).toContainText('Available (125)');
    } else {
      // A project that does number its units by plot must not show the notice.
      await expect(page.locator('[data-qa="plot-no-unit-mapping"]')).toHaveCount(0);
    }
  });

  test('paints a booked and a blocked plot from the API response', async ({ page }) => {
    // Availability is INJECTED here rather than seeded, and that is deliberate:
    // the demo project has no plot-numbered units, so there is no real row to
    // assert against. Faking it at the HTTP boundary (not by stubbing the
    // component) still exercises the whole client path - hook, merge, colour
    // lookup, legend counts - against a real HTTP response, and it keeps the
    // database read-only. The real derivation is covered by the backend unit
    // tests in apps/backend/src/inventory/inventory.plots.test.ts.
    await page.route('**/api/bff/inventory/plots*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          rows: [
            { plotNumber: 5, status: 'booked' },
            { plotNumber: 17, status: 'blocked' },
            { plotNumber: 114, status: 'booked' },
          ],
        }),
      });
    });

    await page.goto(PLOTS_PATH, NAV);
    await waitForMapToHydrate(page);

    expect(await page.locator('[data-plot-number="5"] polygon[fill="#16A34A"]').count()).toBe(1);
    expect(await page.locator('[data-plot-number="17"] polygon[fill="#DC2626"]').count()).toBe(1);
    expect(await page.locator('[data-plot-number="1"] polygon[fill="#9CA3AF"]').count()).toBe(1);
    // EWS plots are painted from the same response.
    expect(await page.locator('[data-plot-number="114"] polygon[fill="#16A34A"]').count()).toBe(1);

    // The legend counts the injected rows, and the notice is gone.
    const legend = page.locator('[data-qa="plot-legend"]');
    await expect(legend).toContainText('Available (122)');
    await expect(legend).toContainText('Booked (2)');
    await expect(legend).toContainText('Blocked (1)');
    await expect(page.locator('[data-qa="plot-no-unit-mapping"]')).toHaveCount(0);

    // The details panel reports the status the API supplied.
    await page.locator('[data-plot-number="5"] polygon[role="button"]').click();
    await expect(page.locator('[data-qa="plot-details"]')).toContainText('Booked');
  });

  test('clicking a plot selects that plot and fills the details panel', async ({ page }) => {
    await page.goto(PLOTS_PATH, NAV);
    await waitForMapToHydrate(page);

    // Click through the polygon, i.e. the same path a user takes.
    await page.locator('[data-plot-number="20"] polygon[role="button"]').click();

    const details = page.locator('[data-qa="plot-details"]');
    await expect(details).toContainText('Plot 20');
    await expect(details).toContainText('Regular plot');
    // Measured area comes from the traced geometry (plot 20 is ~96 sq.m).
    await expect(details).toContainText('m²');
    // No price exists, and the panel says so instead of showing zero.
    await expect(details).toContainText('Not set');

    // The selected plot carries the blue outline.
    expect(
      await page.locator('[data-plot-number="20"] polygon[stroke="#2563EB"]').count()
    ).toBeGreaterThan(0);
  });

  test('zooms in and back out without distorting the drawing, and resets', async ({ page }) => {
    await page.goto(PLOTS_PATH, NAV);
    await waitForMapToHydrate(page);

    const map = page.locator('[data-qa="plot-map"]');
    const initial = await map.getAttribute('viewBox');

    await page.locator('[data-qa="plot-map-zoom-in"]').click();
    const zoomed = await map.getAttribute('viewBox');
    expect(zoomed).not.toBe(initial);

    // Zoom shrinks the visible window and keeps the plan's aspect ratio, so the
    // layout is never stretched.
    const [, , iw, ih] = parseViewBox(initial);
    const [, , zw, zh] = parseViewBox(zoomed);
    expect(zw).toBeLessThan(iw);
    expect(zw / zh).toBeCloseTo(iw / ih, 4);

    // One more step in, then back out, to prove zoom-out is wired to the same
    // clamped viewport rather than a second code path.
    await page.locator('[data-qa="plot-map-zoom-in"]').click();
    const zoomedTwice = await map.getAttribute('viewBox');
    expect(parseViewBox(zoomedTwice)[2]).toBeLessThan(zw);

    await page.locator('[data-qa="plot-map-zoom-out"]').click();
    const backToFirstStep = await map.getAttribute('viewBox');
    expect(parseViewBox(backToFirstStep)[2]).toBeGreaterThan(parseViewBox(zoomedTwice)[2]);
    // Aspect ratio survives the round trip.
    expect(parseViewBox(backToFirstStep)[2] / parseViewBox(backToFirstStep)[3]).toBeCloseTo(
      iw / ih,
      4
    );

    await page.locator('[data-qa="plot-map-reset"]').click();
    await expect(map).toHaveAttribute('viewBox', initial ?? '');
  });

  test('dragging pans the map without being read as a plot click', async ({ page }) => {
    await page.goto(PLOTS_PATH, NAV);
    await waitForMapToHydrate(page);

    const map = page.locator('[data-qa="plot-map"]');
    const before = await map.getAttribute('viewBox');

    const box = await map.boundingBox();
    if (box === null) throw new Error('the map element has no bounding box');
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    // A real drag in steps: the gesture starts on top of a plot polygon, which
    // is what makes this the interesting case.
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 40, startY - 30, { steps: 8 });
    await page.mouse.move(startX - 90, startY - 70, { steps: 8 });
    await page.mouse.up();

    const after = await map.getAttribute('viewBox');
    expect(after).not.toBe(before);

    // The drag is a pan, NOT a selection: pressing on a plot and moving must not
    // leave that plot selected, or panning would hijack the details panel.
    await expect(page.locator('[data-qa="plot-details"]')).toContainText('No plot selected');

    // The map is still complete after panning.
    await expect(page.locator('[data-qa="plot-polygon"]')).toHaveCount(125);
  });

  test('locates a plot by number and flags an unknown one', async ({ page }) => {
    await page.goto(PLOTS_PATH, NAV);
    await waitForMapToHydrate(page);

    // Search reaches the EWS plots too.
    await page.locator('[data-qa="plot-search-input"]').fill('114');
    await page.locator('[data-qa="plot-search-match-114"]').click();
    await expect(page.locator('[data-qa="plot-details"]')).toContainText('EWS plot');

    // A number with no plot reports it rather than silently doing nothing.
    await page.locator('[data-qa="plot-search-input"]').fill('999');
    await expect(page.locator('[data-qa="plot-search-empty"]')).toContainText('No plot numbered');
    // The map is still intact.
    await expect(page.locator('[data-qa="plot-polygon"]')).toHaveCount(125);
  });

  test('keeps plots reachable by the map keyboard cursor', async ({ page }) => {
    await page.goto(PLOTS_PATH, NAV);
    await waitForMapToHydrate(page);

    // Select plot 20 by clicking it, with no filter narrowing the map.
    await page.locator('[data-plot-number="20"] polygon[role="button"]').click();
    await expect(page.locator('[data-qa="plot-details"]')).toContainText('Plot 20');

    // Arrow keys walk the layout by geometry: plot 19 is the plot west of 20.
    await page.locator('[data-qa="plot-map"]').press('ArrowLeft');
    await expect(page.locator('[data-qa="plot-details"]')).toContainText('Plot 19');
  });
});
