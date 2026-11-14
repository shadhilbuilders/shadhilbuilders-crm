// Inventory role gate e2e - ENGINEER must not see villa money, in a real browser.
//
// WHY THIS SPEC EXISTS: the fix for "the engineer must never see inventory" has
// two halves, and only one of them is visible in the DOM.
//
//   1. The UI half: `/inventory` is hard-blocked by `InventoryRouteGate`, and the
//      plot map hands an engineer a link to their own capture screen. A browser
//      test can see that.
//   2. The API half: `GET /api/bff/inventory/units` and `.../plots` are
//      AUDIENCE-PROJECTED - `price`/`pricePerSqft` come back null because the
//      columns are not selected for this role, and the plot claim carries no
//      booking at all. A unit test proves the shape, but only a real request
//      through the real BFF proves nothing re-adds the fields on the way out
//      (a serialize hook, a cache, a proxy rewrite).
//
// The API half is the one that regressed before: the grid's money columns were
// hidden while the JSON still carried the numbers, so devtools read the
// project's pricing without ever rendering the grid. This spec is the guard
// against that class of "fixed in the UI only" bug.
//
// SESSION: this file loads the ENGINEER session saved by `auth.setup.ts` via
// `test.use({ storageState })` below - never a sign-in per test. `workers: 1`
// means the suite shares one `next dev`, and repeated `/login` document loads
// against a compiling server were the flakiest thing in this file.
//
// DATA: the bootstrap org's seeded villas are plot-numbered (seed.ts assigns
// 1-7 / 20-24 / 40-43), so `/plots` returns real claims. The redaction
// assertions below therefore check real claim objects rather than an empty
// envelope - and an empty envelope is asserted to FAIL, so the test cannot pass
// vacuously if the join ever breaks.

import { expect, test, type Page } from '@playwright/test';

import { NAV } from './helpers';

/** The bootstrap org + its default project (packages/database/src/seed.ts). */
const ORG = 'shadhil-builders';
const PROJECT = 'shadhil-metro-heights';
const INVENTORY_PATH = `/${ORG}/projects/${PROJECT}/inventory`;
const SITE_PATH = `/${ORG}/projects/${PROJECT}/site`;

/** Every money-ish key the unit wire contract has ever carried. */
const MONEY_KEYS = ['price', 'pricePerSqft'] as const;

type UnitRow = Record<string, unknown> & { unitNumber?: string };

/**
 * Read a BFF endpoint AS THE SIGNED-IN ENGINEER and return the parsed body.
 *
 * Fetched from inside the page so the request carries the better-auth session
 * cookie and goes through the same `/api/bff` route handler the app uses - a
 * Playwright `request` fixture would need the cookie replayed by hand and would
 * skip the handler under test.
 */
async function fetchAsEngineer(page: Page, path: string): Promise<unknown> {
  return page.evaluate(async (bffPath: string) => {
    const res = await fetch(bffPath, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`GET ${bffPath} -> ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as unknown;
  }, path);
}

/** Pull the unit rows out of either envelope shape the API has used. */
function unitRows(body: unknown): UnitRow[] {
  if (Array.isArray(body)) return body as UnitRow[];
  if (body !== null && typeof body === 'object') {
    const rows = (body as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as UnitRow[];
  }
  return [];
}

test.describe('inventory role gate - an ENGINEER never sees villa money', () => {
  // The ENGINEER session is created ONCE in `auth.setup.ts` and saved to
  // `.auth/engineer.json`. Signing in here instead (the first version did, in
  // beforeEach) cost five `/login` document loads per run against a single
  // `next dev`, and once compiled-and-congested after a heavy spec those
  // navigations timed out - the sign-in became the flakiest part of a file
  // about money redaction. `storageState` is per-CONTEXT, so this overrides the
  // shared demo-OWNER session for these tests only.
  test.use({ storageState: 'src/test/e2e/.auth/engineer.json' });

  test('blocks the inventory grid and points at the site home instead', async ({ page }) => {
    await page.goto(INVENTORY_PATH, NAV);

    // The block panel, NOT a redirect: a redirect would mount the grid first.
    await expect(page.locator('[data-qa="inventory-blocked"]')).toBeVisible({
      timeout: NAV.timeout,
    });
    await expect(page.locator('[data-qa="inventory-blocked"]')).toContainText(
      'Inventory is not part of your work',
    );
    // The block has an exit - it names the surface this role actually works in.
    await expect(page.locator('[data-qa="inventory-blocked-site-link"]')).toHaveAttribute(
      'href',
      SITE_PATH,
    );

    // The grid itself never rendered: no table row, no money column header.
    await expect(page.locator('[data-qa="data-table-row"]')).toHaveCount(0);
    await expect(page.getByText('Per sq.ft price')).toHaveCount(0);
    await expect(page.getByText('Total sq.ft price')).toHaveCount(0);
  });

  test('the blocked exit really lands on the site capture home', async ({ page }) => {
    // A dead end would satisfy "blocked" and still be a broken product.
    await page.goto(INVENTORY_PATH, NAV);

    // WAIT for the panel before clicking. `goto` resolves at
    // `domcontentloaded`, which is well before React has rendered the gate's
    // role-dependent branch (the shell logs "Loading navItems" first), so an
    // immediate click raced the render and failed waiting for a locator that had
    // simply not existed yet. Test 1 above awaits this same locator, which is
    // why only this one flaked.
    const exit = page.locator('[data-qa="inventory-blocked-site-link"]');
    await exit.waitFor({ state: 'visible', timeout: NAV.timeout });
    await exit.click();

    // `NAV` supplies BOTH the `waitUntil` (the app shell holds an SSE stream
    // open, so `load` may never fire) and the 45s ceiling that a cold route
    // compile needs.
    await page.waitForURL(new RegExp(`${SITE_PATH.replace(/[/\\]/g, '\\$&')}$`), NAV);
    await expect(page.locator('[data-qa="site-home"]')).toBeVisible({ timeout: NAV.timeout });
  });

  test('GET /inventory/units returns null money, not the project pricing', async ({ page }) => {
    // The assertion that would have caught the original defect: the number was
    // in this payload while the grid hid it.
    await page.goto(SITE_PATH, NAV);

    const body = await fetchAsEngineer(page, '/api/bff/inventory/units?limit=50');
    const rows = unitRows(body);
    // The bootstrap org is seeded with villas, so an empty answer means the
    // request failed in a way that still parsed - fail on that, do not pass
    // vacuously.
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      for (const key of MONEY_KEYS) {
        // Present-but-null is the contract: the key exists so a client can tell
        // "withheld from you" apart from "the API changed shape".
        expect(row, `${row.unitNumber ?? 'unit'} must carry ${key}`).toHaveProperty(key);
        expect(row[key], `${row.unitNumber ?? 'unit'}.${key} must be null`).toBeNull();
      }
      // ...and nothing else on the row leaks a figure under another name.
      // `buildupSqft`/`sqft` are dimensions, not money, and deliberately stay.
      for (const [key, value] of Object.entries(row)) {
        const looksLikeMoney = /price|amount|token|value/i.test(key);
        if (looksLikeMoney) {
          expect(value, `${row.unitNumber ?? 'unit'}.${key} looks like money`).toBeNull();
        }
      }
    }
  });

  test('the site home still works for the engineer (redaction did not break it)', async ({
    page,
  }) => {
    // The counterweight to every assertion above: withholding money must not
    // cost the engineer the screen they DO use. The site home reads the same
    // units endpoint, so a projection that dropped a needed field would surface
    // here as an empty or error panel.
    await page.goto(SITE_PATH, NAV);

    await expect(page.locator('[data-qa="site-home"]')).toBeVisible({ timeout: NAV.timeout });
    await expect(page.locator('[data-qa="site-home-error"]')).toHaveCount(0);
    await expect(page.locator('[data-qa="site-unit-row"]').first()).toBeVisible({
      timeout: NAV.timeout,
    });
  });

  test('an ENGINEER sees only the villas assigned to them (seed: A-101..A-103, A-201)', async ({
    page,
  }) => {
    // 2026-11-10: RLS narrowed the engineer from "every villa of a team-linked
    // project" to "villas assigned to me". seed.ts assigns four Metro Heights
    // villas to the seeded engineer and leaves A-104 / B-101 unassigned.
    await page.goto(SITE_PATH, NAV);

    const body = await fetchAsEngineer(page, '/api/bff/inventory/units?limit=200');
    const numbers = unitRows(body).map((row) => String(row.unitNumber));

    for (const assigned of ['A-101', 'A-102', 'A-103', 'A-201']) {
      expect(numbers, `${assigned} is assigned and must be visible`).toContain(assigned);
    }
    for (const unassigned of ['A-104', 'A-202', 'B-101', 'C-101']) {
      expect(numbers, `${unassigned} is unassigned and must be hidden`).not.toContain(unassigned);
    }
  });

  test('the plot map carries no prices and no deal for an ENGINEER', async ({ page }) => {
    // Fetch the payload from the SITE home, not `/plots`: this assertion is
    // about the API projection, and navigating to the map would spend the test's
    // budget compiling a heavy SVG route for no extra evidence. The route's own
    // behaviour is covered by `plot-layout.spec.ts`.
    await page.goto(SITE_PATH, NAV);

    const body = await fetchAsEngineer(page, '/api/bff/inventory/plots');
    const rows = Array.isArray((body as { rows?: unknown })?.rows)
      ? ((body as { rows: Array<Record<string, unknown>> }).rows ?? [])
      : null;
    // A non-array `rows` means the contract changed and the map reads nothing.
    expect(rows).not.toBeNull();
    const plotRows = rows ?? [];

    // The bootstrap org's villas ARE plot-numbered (seed.ts assigns 1-7 / 20-24
    // / 40-43), so an empty map here means the plot join broke - not that there
    // is nothing to assert. Passing vacuously would hide exactly the regression
    // this test exists for.
    expect(plotRows.length).toBeGreaterThan(0);

    let claimsChecked = 0;
    for (const row of plotRows) {
      for (const claim of (row['units'] as Array<Record<string, unknown>>) ?? []) {
        const unit = (claim['unit'] ?? {}) as Record<string, unknown>;
        const label = String(unit['unitNumber'] ?? 'unit');
        // Money is withheld by projection, so the keys exist and are null.
        expect(unit, `${label} must carry price`).toHaveProperty('price');
        expect(unit['price'], `${label}.price`).toBeNull();
        expect(unit['pricePerSqft'], `${label}.pricePerSqft`).toBeNull();
        // The deal (amount + buyer name) is withheld WHOLESALE - the claim's
        // booking is null, which the panel already words as "not visible to
        // you". A future change that blanked fields instead of dropping the
        // booking would still leak who holds the villa.
        expect(claim['booking'], `${label}.booking`).toBeNull();
        claimsChecked += 1;
      }
    }
    expect(claimsChecked).toBeGreaterThan(0);
  });
});
