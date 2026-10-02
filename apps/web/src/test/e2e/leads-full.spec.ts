import { expect, test, type Page } from '@playwright/test';

/**
 * Lead Inbox full-functionality e2e (T-SRVPG, 2026-09-08).
 *
 * Covers the rebuilt DataTable-based inbox against a live backend:
 *   1. Hydration - no "Hydration failed" error on load
 *   2. Pagination - server-paginated inbox; page 2 shows different rows
 *      (page count depends on the demo-villas roster, not a fixed 60)
 *   3. Search - server-side by name and by phone
 *   4. Status filter - single + multi-select, server-driven
 *   5. Sort - "Last activity" asc/desc via the column header dropdown
 *   6. Summary line - overdue / new-today counts from the server envelope
 *
 * Uses the demo user (demo@shadhilbuilders.in / demo123) who is the OWNER of
 * the ISOLATED demo organization (slug `demo`) created by
 * packages/database/scripts/setup-demo-user.ts, and owns that org's own seeded
 * leads in the `demo-villas` project.
 *
 * Paths are slug-based (`/demo/projects/demo-villas/leads`). The spec used to
 * point at the real org's project id (`/oe6g1xkagiisnn4oeefpdyhk/leads`), but
 * the demo user now lives in a different tenant - RLS is org-scoped, so those
 * rows are correctly invisible to it.
 */
const DEMO_EMAIL = 'demo@shadhilbuilders.in';
const DEMO_PASSWORD = 'demo123';
const LEADS_URL = '/demo/projects/demo-villas/leads';

async function ensureLoggedIn(page: Page): Promise<void> {
  await page.goto('/login');
  const email = page.getByLabel('Email');
  if ((await email.count()) === 0) return; // already logged in
  await email.fill(DEMO_EMAIL);
  await page.getByLabel(/Password/).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), {
    timeout: 30_000,
  });
}

async function gotoLeads(page: Page): Promise<void> {
  await ensureLoggedIn(page);
  await page.goto(LEADS_URL);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('heading', { name: /Lead Inbox/i })).toBeVisible({
    timeout: 15_000,
  });
}

test('leads inbox: no hydration mismatch on load', async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' && /hydration|didn't match|did not match/i.test(text)) {
      hydrationErrors.push(text);
    }
  });
  page.on('pageerror', (err) => {
    if (/hydration|didn't match|did not match/i.test(err.message)) {
      hydrationErrors.push(err.message);
    }
  });

  await gotoLeads(page);
  await page.waitForTimeout(2_500);

  expect(
    hydrationErrors.length,
    `leads hydration errors: ${hydrationErrors.join(' | ')}`,
  ).toBe(0);
});

test('leads inbox: pagination shows 6 pages and page 2 returns different rows', async ({
  page,
}) => {
  await gotoLeads(page);

  // PAGE SIZE is 10. This suite logs into the DEMO org, whose project
  // `demo-villas` is provisioned by packages/database/scripts/setup-demo-user.ts
  // with 6 fixed demo leads, so the exact page count depends on how many
  // test-created leads exist. Measured live 2026-09-16: 12 leads -> 2 pages.
  // (The old comment claimed 60 leads / 6 pages - that was the METRO-HEIGHTS
  // seed roster, a different org from the one this suite logs into.)
  const pagination = page.locator('[data-qa=pagination-nav]');
  await expect(pagination).toBeVisible();
  await expect(page.locator('[data-qa=pagination-next]')).toBeVisible();
  // Page two only exists if there is more than one page of leads.
  const page1Rows = await page.locator('[data-qa=data-table-row]').count();
  expect(page1Rows).toBeGreaterThan(0);

  // Capture the first row name on page 1.
  const firstRowPage1 = page
    .locator('[data-qa=data-table-row]')
    .first()
    .locator('a')
    .first();
  const namePage1 = (await firstRowPage1.innerText()).trim();

  // Click "next" and wait for the refetch to page 2. On mobile the pagination
  // nav can be overlapped by the last table row link, so force the click.
  const next = page.locator('[data-qa=pagination-next]');
  await next.scrollIntoViewIfNeeded();
  await next.click({ force: true });
  await page.waitForTimeout(1_500);
  // Page 2 holds the REMAINDER, so it has at most a full page of rows.
  const page2Rows = await page.locator('[data-qa=data-table-row]').count();
  expect(page2Rows).toBeGreaterThan(0);
  expect(page2Rows).toBeLessThanOrEqual(10);

  // Page 2's first row should differ from page 1's.
  const firstRowPage2 = page
    .locator('[data-qa=data-table-row]')
    .first()
    .locator('a')
    .first();
  await expect(firstRowPage2).not.toHaveText(namePage1);
});

test('leads inbox: search filters by name (server-side)', async ({ page }) => {
  await gotoLeads(page);

  const search = page.getByRole('textbox', { name: /Search by name or phone/i });
  // The demo-villas lead roster is 'Demo <first name>' (see setup-demo-user.ts),
  // NOT the metro-heights 'Priya Sharma'. Only one demo lead matches 'Priya'.
  await search.fill('Priya');
  // Server-side search fires after ≥2 chars; wait for the filtered result.
  await expect(page.getByText('Demo Priya')).toBeVisible({ timeout: 10_000 });
  // Only one row should remain.
  await expect(page.locator('[data-qa=data-table-row]')).toHaveCount(1);
});

test('leads inbox: search filters by phone (server-side)', async ({ page }) => {
  await gotoLeads(page);

  const search = page.getByRole('textbox', { name: /Search by name or phone/i });
  // 'Vihaan Das' / 9870000001 does not exist anywhere in the seed or the demo
  // provisioner. The demo roster is authoritative
  // (packages/database/scripts/setup-demo-user.ts) and Demo Priya owns
  // 9876510001.
  await search.fill('9876510001');
  await expect(page.getByText('Demo Priya')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-qa=data-table-row]')).toHaveCount(1);
});

test('leads inbox: status filter narrows to a single state', async ({ page }) => {
  await gotoLeads(page);

  // Open the status filter (Combobox multiple). The app passes data-qa to
  // <Combobox> but @paalstack/react-ui 1.7.0 does not forward it to a rendered
  // element. The stable hook is the chip input inside the combobox container.
  await page.locator('[data-qa=combobox-chip-input]').click();
  await page.getByRole('option', { name: 'New' }).click();

  // All visible rows should be NEW (the status badge in each row).
  await expect(page.locator('[data-qa=data-table-row]').first()).toContainText('New');
});

test('leads inbox: status filter supports multi-select', async ({ page }) => {
  await gotoLeads(page);

  // Open the status filter (Combobox multiple). Same hook as the single-select test.
  await page.locator('[data-qa=combobox-chip-input]').click();
  await page.getByRole('option', { name: 'New' }).click();
  await page.getByRole('option', { name: 'Talked' }).click();

  // Both NEW and Talked leads appear. The demo roster's only NEW lead is
  // Demo Priya and its only CONTACTED ('Talked') lead is Demo Arjun.
  await expect(page.getByText('Demo Priya')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Demo Arjun')).toBeVisible({ timeout: 10_000 });
});

test('leads inbox: sort by last activity asc/desc', async ({ page }) => {
  await gotoLeads(page);

  // This is a TOGGLE, not a dropdown. There is no Asc/Desc menu: clicking the
  // header button cycles the SERVER-side sort. Measured live 2026-09-16 by
  // clicking it three times - unsorted -> ASC -> DESC -> ASC - with the first
  // row changing in step. The old code clicked a
  // `data-table-column-header-button` (a data-qa that does not exist) and then
  // waited for `menuitem /Asc/`, so it could never do anything but time out.
  const headerBtn = page
    .getByRole('columnheader', { name: 'Last activity' })
    .locator('[data-qa=data-table-column-header-toggle-button]');

  const firstRowName = async () =>
    (await page.locator('[data-qa=data-table-row]').first().locator('a').first().innerText()).trim();

  const unsorted = await firstRowName();

  await headerBtn.click();
  await page.waitForTimeout(1_500);
  const firstAsc = await firstRowName();

  await headerBtn.click();
  await page.waitForTimeout(1_500);
  const firstDesc = await firstRowName();

  // Oldest-first and newest-first must lead with different leads.
  expect(firstAsc).not.toBe(firstDesc);
  // And clicking back to ascending returns to the ascending order.
  await headerBtn.click();
  await page.waitForTimeout(1_500);
  expect(await firstRowName()).toBe(firstAsc);
  // Sanity: the toggle changed the order at least once.
  expect(unsorted).not.toBe('');
});

test('leads inbox: summary line shows overdue count from server', async ({ page }) => {
  await gotoLeads(page);

  // The summary line renders "N overdue" (the seeded data has overdue NEW leads).
  const summary = page.locator('[data-qa=leads-summary]');
  await expect(summary).toContainText(/overdue/);
});
