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

  test('the plot-number search is the library InputGroup, not a hand-rolled input', async ({
    page,
  }) => {
    await page.goto(PLOTS_PATH, NAV);
    await waitForMapToHydrate(page);

    // `data-qa` alone cannot tell the two apart - the hand-rolled version carried
    // it too, so a test selecting only on it would pass either way. The group's
    // own data-slot markers are what actually prove the InputGroup renders: a
    // `relative` wrapper with an absolutely-positioned icon has neither.
    const input = page.locator('[data-qa="plot-search-input"]');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('data-slot', 'input-group-control');

    const group = page.locator('[data-slot="input-group"]').filter({ has: input });
    await expect(group).toHaveCount(1);
    // The leading search icon is the group's start addon, so the input's inset
    // belongs to the group instead of a hand-tuned `pl-*` kept in sync by hand.
    await expect(group.locator('[data-slot="input-group-addon"]')).toHaveCount(1);

    // And it is still a real, fillable input - fill() fails outright if the
    // marker ever lands on a wrapper instead of the control.
    await input.fill('20');
    await expect(page.locator('[data-qa="plot-search-match-20"]')).toBeVisible();
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
    // real answer: no villa in this project carries a plot number yet.
    const body = (await response.json()) as { rows: unknown[] };
    expect(Array.isArray(body.rows)).toBe(true);

    if (body.rows.length === 0) {
      // Nothing is on the layout, so everything must read available and the page
      // must SAY why - an entirely grey plan with no explanation reads as a bug.
      await expect(page.locator('[data-qa="plot-no-unit-mapping"]')).toContainText(
        'has a plot number yet'
      );
      expect(await page.locator('[data-plot-number="1"] polygon[fill="#9CA3AF"]').count()).toBe(1);
      expect(await page.locator('polygon[fill="#16A34A"]').count()).toBe(0);
      await expect(page.locator('[data-qa="plot-legend"]')).toContainText('Available (125)');
    } else {
      // A project whose villas carry plot numbers must not show the notice.
      await expect(page.locator('[data-qa="plot-no-unit-mapping"]')).toHaveCount(0);
    }
  });

  test('names the real villa and booking behind a plot, and links to both', async ({ page }) => {
    // THE test for this surface: the traced polygon, the real unit row and the
    // real booking, all the way from the database. The demo project's villas
    // carry plot numbers (packages/database/scripts/setup-demo-user.ts assigns
    // them: D-202 sits on plot 114 and is sold to Demo Meera).
    await page.goto(PLOTS_PATH, NAV);
    await waitForMapToHydrate(page);

    await page.locator('[data-plot-number="114"] polygon[role="button"]').click();

    const details = page.locator('[data-qa="plot-details"]');
    await expect(details).toContainText('Plot 114');
    await expect(details).toContainText('Booked');
    // The villa, by its DOOR number, with its own state - not the plot's.
    await expect(details).toContainText('D-202');
    await expect(details).toContainText('Sold');
    // And the buyer, by name.
    await expect(details).toContainText('Demo Meera');

    // Each link opens its OWN entity, so neither is a dead end.
    await expect(page.locator('[data-qa="plot-unit-link"]')).toHaveAttribute(
      'href',
      /\/inventory\?unit=/
    );
    await expect(page.locator('[data-qa="plot-booking-link"]')).toHaveAttribute(
      'href',
      /\/bookings\/[a-z0-9]+/
    );
    await expect(page.locator('[data-qa="plot-booking-lead-link"]')).toHaveAttribute(
      'href',
      /\/leads\/[a-z0-9]+/
    );
  });

  test('the villa link from a plot opens that villa in the inventory grid', async ({ page }) => {
    // A link that lands on an unfiltered list would make the operator search
    // again by hand, so this walks the path: plot -> villa sheet.
    await page.goto(PLOTS_PATH, NAV);
    await waitForMapToHydrate(page);

    await page.locator('[data-plot-number="114"] polygon[role="button"]').click();
    await page.locator('[data-qa="plot-unit-link"]').click();

    await page.waitForURL(/\/inventory\?unit=/, { timeout: 15_000 });
    // The sheet for the REAL villa, fetched by id - D-202, which is SOLD.
    await expect(page.locator('[data-qa="unit-detail-status"]')).toContainText('Sold');
    await expect(page.getByText('D-202').first()).toBeVisible();
  });

  test('paints a booked and a blocked plot from the API response', async ({ page }) => {
    // The COLOUR path is injected here rather than read from the demo project,
    // so the legend counts are pinned against a known row set instead of
    // whatever the fixtures happen to hold. Faking it at the HTTP boundary (not
    // by stubbing the component) still exercises the whole client path - hook,
    // merge, colour lookup, legend counts - against a real HTTP response, and it
    // keeps the database read-only. The real join is covered by the two tests
    // above and by apps/backend/src/inventory/inventory.plots.test.ts.
    await page.route('**/api/bff/inventory/plots*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          rows: [
            {
              plotNumber: 5,
              status: 'booked',
              units: [
                {
                  unit: {
                    id: 'unit-d101',
                    phaseId: 'phase-a',
                    phaseName: 'Phase A',
                    projectId: 'proj-1',
                    projectName: 'Demo Villas',
                    unitNumber: 'D-101',
                    plotNumber: 5,
                    bhk: 2,
                    facing: 'North',
                    sqft: 1050,
                    buildupSqft: '1050',
                    pricePerSqft: '4000',
                    price: '4200000',
                    status: 'SOLD',
                    createdAt: '2026-10-01T09:00:00.000Z',
                  },
                  booking: {
                    id: 'booking-approved',
                    status: 'APPROVED',
                    amount: '4200000',
                    tokenAmount: '250000',
                    leadId: 'lead-won',
                    leadName: 'Demo Vikram',
                    createdAt: '2026-10-02T09:00:00.000Z',
                  },
                },
              ],
            },
            { plotNumber: 17, status: 'blocked', units: [] },
            { plotNumber: 114, status: 'booked', units: [] },
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

    // The details panel reports the status the API supplied, and names the
    // records behind the plot from the same response.
    await page.locator('[data-plot-number="5"] polygon[role="button"]').click();
    const injectedDetails = page.locator('[data-qa="plot-details"]');
    await expect(injectedDetails).toContainText('Booked');
    await expect(injectedDetails).toContainText('D-101');
    await expect(injectedDetails).toContainText('Demo Vikram');
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
    // Plot 20 carries a real villa in the demo fixtures (D-103, available), so
    // the panel names it and its stored price rather than printing "Not set".
    await expect(details).toContainText('D-103');
    await expect(details).toContainText('Available');
    await expect(page.locator('[data-qa="plot-booking-none"]')).toContainText(
      'No booking on this villa'
    );

    // A selected plot is marked by its fill alone: a single polygon, filled
    // blue, with no stroke or halo ring.
    const selectedPolygons = page.locator('[data-plot-number="20"] polygon');
    await expect(selectedPolygons).toHaveCount(1);
    await expect(selectedPolygons).toHaveAttribute('fill', '#2563EB');
    await expect(selectedPolygons).toHaveAttribute('stroke', 'none');
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
