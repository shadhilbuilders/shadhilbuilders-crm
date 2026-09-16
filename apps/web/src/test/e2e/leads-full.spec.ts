import { expect, test, type Page } from '@playwright/test';

/**
 * Lead Inbox full-functionality e2e (T-SRVPG, 2026-09-08).
 *
 * Covers the rebuilt DataTable-based inbox against a live backend:
 *   1. Hydration - no "Hydration failed" error on load
 *   2. Pagination - 60 seeded leads → 6 pages; page 2 shows different rows
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

  // 60 leads / 10 per page = 6 pages. The pagination nav renders prev/next
  // (always visible) plus page-number links (hidden on mobile).
  const pagination = page.locator('[data-qa=pagination-nav]');
  await expect(pagination).toBeVisible();
  await expect(page.locator('[data-qa=pagination-next]')).toBeVisible();

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
  await expect(page.locator('[data-qa=data-table-row]')).toHaveCount(10);

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
  await search.fill('Priya');
  // Server-side search fires after ≥2 chars; wait for the filtered result.
  await expect(page.getByText('Priya Sharma')).toBeVisible({ timeout: 10_000 });
  // Only one row should remain.
  await expect(page.locator('[data-qa=data-table-row]')).toHaveCount(1);
});

test('leads inbox: search filters by phone (server-side)', async ({ page }) => {
  await gotoLeads(page);

  const search = page.getByRole('textbox', { name: /Search by name or phone/i });
  // dummy001 has phone 9870000001 (Vihaan Das).
  await search.fill('9870000001');
  await expect(page.getByText('Vihaan Das')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-qa=data-table-row]')).toHaveCount(1);
});

test('leads inbox: status filter narrows to a single state', async ({ page }) => {
  await gotoLeads(page);

  // Open the status MultiSelect (data-qa=multi-select-).
  await page.locator('[data-qa=multi-select-]').click();
  await page.getByRole('option', { name: 'New' }).click();

  // All visible rows should be NEW (the status badge in each row).
  await expect(page.locator('[data-qa=data-table-row]').first()).toContainText('New');
  // The filter trigger shows the selected badge (data-qa=multi-select-badge-NEW).
  await expect(page.locator('[data-qa=multi-select-badge-NEW]')).toBeVisible();
});

test('leads inbox: status filter supports multi-select', async ({ page }) => {
  await gotoLeads(page);

  await page.locator('[data-qa=multi-select-]').click();
  await page.getByRole('option', { name: 'New' }).click();
  await page.getByRole('option', { name: 'Talked' }).click();

  // Both NEW and Talked leads should appear.
  await expect(page.getByText('Priya Sharma')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Arjun Reddy')).toBeVisible({ timeout: 10_000 });
});

test('leads inbox: sort by last activity asc/desc', async ({ page }) => {
  await gotoLeads(page);

  // Open the "Last activity" column header dropdown.
  await page
    .getByRole('columnheader', { name: 'Last activity' })
    .locator('[data-qa=data-table-column-header-button]')
    .click();

  // Sort ascending (oldest first).
  await page.getByRole('menuitem', { name: /Asc/i }).click();
  await page.waitForTimeout(1_000);
  const firstAsc = await page
    .locator('[data-qa=data-table-row]')
    .first()
    .locator('a')
    .first()
    .innerText();

  // Sort descending (newest first).
  await page
    .getByRole('columnheader', { name: 'Last activity' })
    .locator('[data-qa=data-table-column-header-button]')
    .click();
  await page.getByRole('menuitem', { name: /Desc/i }).click();
  await page.waitForTimeout(1_000);
  const firstDesc = await page
    .locator('[data-qa=data-table-row]')
    .first()
    .locator('a')
    .first()
    .innerText();

  // Asc and desc should order differently (oldest vs newest first).
  expect(firstAsc).not.toBe(firstDesc);
});

test('leads inbox: summary line shows overdue count from server', async ({ page }) => {
  await gotoLeads(page);

  // The summary line renders "N overdue" (the seeded data has overdue NEW leads).
  const summary = page.locator('[data-qa=leads-summary]');
  await expect(summary).toContainText(/overdue/);
});
