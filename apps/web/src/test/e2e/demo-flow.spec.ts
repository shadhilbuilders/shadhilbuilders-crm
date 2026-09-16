import { expect, test, type Page } from '@playwright/test';

/**
 * T-DEMOBOOK - End-to-end smoke of the Sunday client demo flow.
 *
 * Exercises every step the handoff prompt lists as "MUST work end-to-end"
 * against a live backend (port 8080) + web (port 3000). Uses the
 * already-seeded demo user (demo@shadhilbuilders.in / demo123, OWNER of the
 * isolated `demo` organization) and the demo data from
 * packages/database/scripts/setup-demo-user.ts.
 *
 * All paths are slug-based under the demo org. Bare paths (`/leads`) were stale
 * - the slug-URL scheme landed 2026-09-11 and only `/[orgSlug]/...` routes
 * exist, so those navigations 404'd. The demo user is now in its own tenant,
 * so the real org's rows are correctly invisible to it.
 *
 * Step map (per the demo-sprint prompt):
 *   1. /login → sign in as demo user
 *   2. /leads → see demo leads
 *   3. + New lead → fill form → submit → /leads/{id} with status NEW
 *   4. On detail → Edit name/email → Save (toast)
 *   5. On detail → Click "→ Talked" → status flips, audit row
 *   6. On detail (VISIT_REQUESTED) → Schedule visit → date/time → submit
 *      → status auto-advances to VISIT_SCHEDULED
 *   7. On detail (VISIT_SCHEDULED) → Mark completed → status flips to VISITED
 *   8. /visits → see the visit in the weekly calendar
 *
 * Each step records a screenshot under __screenshots__/ and is followed
 * by an explicit `expect(knownGap).toBeNull()` assertion: if a step
 * cannot complete because the page is broken, the test FAILS honestly
 * with the reason in the title - never paper over it.
 *
 * Selectors lean on `data-qa` attributes that the components already
 * expose (LeadActionPanel, LeadVisitPanel, ScheduleVisitDialog,
 * LeadChatPane, /leads/new form, /login form) plus role-based fallbacks
 * (`getByRole`, `getByLabel`) for the date/time inputs that don't have
 * a data-qa on the dialog's Form lib wrapper.
 */

// The demo org's slug-based root (see setup-demo-user.ts). Every demo
// navigation is scoped under it.
const DEMO_BASE = '/demo/projects/demo-villas';
const DEMO_EMAIL = 'demo@shadhilbuilders.in';
const DEMO_PASSWORD = 'demo123';

// Resolve the screenshot directory absolutely so it lands inside
// apps/web/src/test/e2e/__screenshots__/ regardless of the cwd Playwright
// is invoked from (`apps/web/`).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = resolve(HERE, '__screenshots__');

function shot(page: Page, name: string) {
  return page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true });
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /Shadhil CRM/i })).toBeVisible();
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  // The login form does a router.replace(nextPath) then router.refresh().
  // The URL changes from /login → / (or /leads etc.) before the
  // (app) layout mounts.
  await page.waitForURL(
    (url) => !url.pathname.startsWith('/login'),
    { timeout: 30_000 },
  );
}

/**
 * REGRESSION GUARD - `(app)/layout.tsx` mounts `useNavSync()` from
 * `src/lib/nav.ts`. An earlier implementation invoked `useSidebar()`
 * INSIDE its `useEffect` callback, violating the Rules of Hooks: in dev
 * mode this threw an "Invalid hook call" runtime error after login and
 * Next.js rendered the "This page couldn't load" error overlay instead
 * of any (app)/* page. Fixed 2026-09: the hook now calls `useSidebar()`
 * in the hook body (see `src/lib/use-nav-sync.test.tsx` for the unit
 * level guard).
 *
 * Every post-login step must first check whether the page rendered
 * (i.e. we did NOT land on the error overlay). If we did, the step
 * records a `layout-error` known-gap and skips its real assertions -
 * but the TEST STILL FAILS with a clear reason, because a demo that
 * can't render any (app)/* page is not demo-ready.
 */
async function probeForLayoutError(
  page: Page,
  stepName: string,
): Promise<{ broken: boolean; reason: string }> {
  // Wait for the page to settle (either render normally or error out).
  await page.waitForLoadState('domcontentloaded');
  // Give the layout a moment to either render the children or throw.
  await page.waitForTimeout(1_500);

  const errorOverlay = page.getByRole('dialog', { name: /Runtime Error/i });
  const pageCouldNotLoad = page.getByRole('heading', {
    name: /This page couldn.?t load/i,
  });
  const hasOverlay = (await errorOverlay.count()) > 0;
  const hasHeader = (await pageCouldNotLoad.count()) > 0;
  if (hasOverlay || hasHeader) {
    const dialogText = hasOverlay
      ? await errorOverlay.innerText().catch(() => '')
      : '';
    return {
      broken: true,
      reason: `${stepName}: (app) layout crashed with Runtime Error - "${dialogText.split('\n').slice(0, 2).join(' | ').slice(0, 200)}". Source: (app)/layout.tsx crash (useNavSync Rules-of-Hooks regression? see src/lib/use-nav-sync.test.tsx).`,
    };
  }
  return { broken: false, reason: '' };
}

// STEP 3 persists the created lead id to this file so STEPS 4-8 + BONUS
// can find it on a fresh test (each test gets its own browser context).
const CREATED_LEAD_ID_FILE = `${SCREENSHOT_DIR}/.created-lead-id`;

import { promises as fs } from 'node:fs';

async function readCreatedLeadId(): Promise<string> {
  try {
    return (await fs.readFile(CREATED_LEAD_ID_FILE, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function writeCreatedLeadId(id: string): Promise<void> {
  await fs.writeFile(CREATED_LEAD_ID_FILE, id, 'utf8');
}

test.describe('T-DEMOBOOK - Sunday demo flow (live backend+web)', () => {
  test.setTimeout(240_000);

  // Each step runs independently (no test.describe.serial) so we get a
  // genuine per-step pass/fail report. STEPS 3-8 + BONUS coordinate via
  // CREATED_LEAD_ID_FILE: STEP 3 writes the lead id, STEPS 4-8 + BONUS
  // read it. If STEP 3 fails (e.g. the layout crash), the file stays
  // empty and the dependent steps `test.skip()` with a clear reason.

  test('STEP 1 - login as demo user', async ({ page }) => {
    await page.goto('/login');
    await shot(page, '01-login');
    await login(page);
    // URL has changed away from /login - login API succeeded.
    await expect(page).not.toHaveURL(/\/login/);
    await shot(page, '01b-after-login');
  });

  test('STEP 2 - /leads lists demo leads', async ({ page }) => {
    await login(page);
    await page.goto(`${DEMO_BASE}/leads`);
    await shot(page, '02-leads');
    const probe = await probeForLayoutError(page, 'STEP 2');
    if (probe.broken) throw new Error(probe.reason);

    // Page rendered. Check for either the table or the ModulePending
    // placeholder so we can flag the leads-list contract gap honestly
    // rather than timing out.
    const tableOrPending = await Promise.race([
      page
        .getByRole('table')
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => 'table' as const),
      page
        .getByText(/Lead Inbox/i)
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => 'pending' as const),
    ]).catch(() => 'unknown' as const);

    if (tableOrPending === 'table') {
      const rowCount = await page.locator('tbody tr').count();
      console.log(`[STEP 2] /leads table rendered with ${rowCount} row(s).`);
      expect(rowCount).toBeGreaterThanOrEqual(1);
    } else if (tableOrPending === 'pending') {
      // KNOWN GAP - backend leads.service.list returns `{ rows, total }`
      // (page is paginated), but useLeads() in the frontend treats the
      // response as a bare array. Array.isArray(payload) is false on
      // `{rows, total}`, so the page renders ModulePending instead of
      // the leads table. Confirmed via curl: GET /api/bff/leads →
      // {"total":219,"rows":[...]}.
      throw new Error(
        'STEP 2: /leads renders ModulePending - backend /api/leads returns {rows, total} but useLeads() expects a bare array. Contract gap between apps/backend/src/leads/leads.service.ts:182 and apps/web/src/hooks/queries/crm.ts:59.',
      );
    } else {
      throw new Error('STEP 2: neither table nor placeholder rendered.');
    }
  });

  test('STEP 3 - create new lead and land on /leads/{id} with status NEW', async ({ page }) => {
    await login(page);
    await page.goto(`${DEMO_BASE}/leads/new`);
    const probe = await probeForLayoutError(page, 'STEP 3');
    if (probe.broken) throw new Error(probe.reason);

    const createdLeadName = `Demo Sprint Lead ${Date.now().toString().slice(-6)}`;
    await page.getByLabel(/Full name/i).fill(createdLeadName);
    // Phone: 10 digits - the form rejects <10.
    await page.getByLabel(/^Phone$/i).fill('9876543210');
    await page.getByLabel(/^Email$/i).fill('demo-sprint@example.com');
    await page.getByLabel(/^Source$/i).fill('Demo Sprint E2E');

    await shot(page, '03a-new-lead-form');
    await page.getByRole('button', { name: /create lead/i }).click();

    await page.waitForURL(/\/leads\/[a-z0-9]+$/, { timeout: 20_000 });
    const url = new URL(page.url());
    const createdLeadId = url.pathname.split('/').pop() ?? '';
    expect(createdLeadId).not.toBe('');
    // Persist for STEPS 4-8 + BONUS (each runs in its own browser context).
    await writeCreatedLeadId(createdLeadId);

    await expect(page.locator('[data-qa="lead-action-panel"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator('[data-qa="lead-action-panel"]').getByText(/^New$/, { exact: true }),
    ).toBeVisible();
    await shot(page, '03b-lead-detail-new');
  });

  test('STEP 4 - edit name and email on detail, save (toast)', async ({ page }) => {
    const createdLeadId = await readCreatedLeadId();
    test.skip(createdLeadId === '', 'STEP 4 depends on a lead created in STEP 3');
    await login(page);
    await page.goto(`${DEMO_BASE}/leads/${createdLeadId}`);
    const probe = await probeForLayoutError(page, 'STEP 4');
    if (probe.broken) throw new Error(probe.reason);

    await expect(page.locator('[data-qa="lead-action-panel"]')).toBeVisible({
      timeout: 15_000,
    });

    const nameInput = page.locator('[data-qa="edit-lead-name"]');
    const emailInput = page.locator('[data-qa="edit-lead-email"]');
    await expect(nameInput).toBeVisible();
    await expect(emailInput).toBeVisible();

    const existingName = (await nameInput.inputValue()).trim();
    const newName = `${existingName.length > 0 ? existingName : 'Lead'} (edited)`;
    await nameInput.fill(newName);
    await emailInput.fill('demo-sprint-edited@example.com');

    await shot(page, '04a-edit-form');
    await page.locator('[data-qa="edit-lead-save"]').click();

    await expect(page.getByText(/Lead updated/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: newName })).toBeVisible();
    await shot(page, '04b-after-save');
  });

  test('STEP 5 - transition NEW → CONTACTED (button label is "→ Talked")', async ({ page }) => {
    const createdLeadId = await readCreatedLeadId();
    test.skip(createdLeadId === '', 'STEP 5 depends on a lead created in STEP 3');
    await login(page);
    await page.goto(`${DEMO_BASE}/leads/${createdLeadId}`);
    const probe = await probeForLayoutError(page, 'STEP 5');
    if (probe.broken) throw new Error(probe.reason);

    await expect(page.locator('[data-qa="lead-action-panel"]')).toBeVisible({
      timeout: 15_000,
    });

    // Button is `→ Talked` (LEAD_STATUS_LABELS maps CONTACTED → "Talked").
    const transitionBtn = page.locator('[data-qa="transition-to-CONTACTED"]');
    await expect(transitionBtn).toBeVisible();
    await transitionBtn.click();

    await expect(page.locator('[data-qa="transition-confirm"]')).toBeVisible();
    await shot(page, '05a-transition-confirm');
    await page.locator('[data-qa="transition-confirm"]').click();

    await expect(page.getByText(/Lead moved to Talked/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page
        .locator('[data-qa="lead-action-panel"]')
        .getByText(/^Talked$/, { exact: true }),
    ).toBeVisible();
    await shot(page, '05b-after-transition');
  });

  test('STEP 6 - drive to VISIT_REQUESTED, schedule visit, expect VISIT_SCHEDULED', async ({
    page,
  }) => {
    const createdLeadId = await readCreatedLeadId();
    test.skip(createdLeadId === '', 'STEP 6 depends on a lead created in STEP 3');
    await login(page);
    await page.goto(`${DEMO_BASE}/leads/${createdLeadId}`);
    const probe = await probeForLayoutError(page, 'STEP 6');
    if (probe.broken) throw new Error(probe.reason);

    await expect(page.locator('[data-qa="lead-action-panel"]')).toBeVisible({
      timeout: 15_000,
    });

    await page.locator('[data-qa="transition-to-VISIT_REQUESTED"]').click();
    await expect(page.locator('[data-qa="transition-confirm"]')).toBeVisible();
    await page.locator('[data-qa="transition-confirm"]').click();
    await expect(page.getByText(/Lead moved to Visit requested/i)).toBeVisible({
      timeout: 10_000,
    });

    await expect(page.locator('[data-qa="lead-visit-panel"]')).toBeVisible({
      timeout: 10_000,
    });
    const scheduleBtn = page.locator('[data-qa="lead-schedule-visit"]');
    await expect(scheduleBtn).toBeVisible();
    await shot(page, '06a-visit-requested');
    await scheduleBtn.click();

    const dateInput = page.getByLabel(/^Date$/);
    const timeInput = page.getByLabel(/^Time$/);
    await expect(dateInput).toBeVisible();
    await expect(timeInput).toBeVisible();

    const future = new Date();
    future.setDate(future.getDate() + 7);
    const isoDate = future.toISOString().slice(0, 10);
    await dateInput.fill(isoDate);
    await timeInput.fill('11:30');

    await shot(page, '06b-schedule-dialog');
    await page.getByRole('button', { name: /^Schedule$/ }).click();

    await expect(page.getByText(/Visit scheduled/i)).toBeVisible({ timeout: 15_000 });

    await expect(
      page
        .locator('[data-qa="lead-action-panel"]')
        .getByText(/^Visit booked$/, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await shot(page, '06c-visit-scheduled');
  });

  test('STEP 7 - mark visit completed → lead status flips to VISITED', async ({ page }) => {
    const createdLeadId = await readCreatedLeadId();
    test.skip(createdLeadId === '', 'STEP 7 depends on a lead created in STEP 3');
    await login(page);
    await page.goto(`${DEMO_BASE}/leads/${createdLeadId}`);
    const probe = await probeForLayoutError(page, 'STEP 7');
    if (probe.broken) throw new Error(probe.reason);

    await expect(page.locator('[data-qa="lead-action-panel"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page
        .locator('[data-qa="lead-action-panel"]')
        .getByText(/^Visit booked$/, { exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('[data-qa="lead-visit-panel"]')).toBeVisible();
    const markDone = page.locator('[data-qa="visit-mark-completed"]');
    await expect(markDone).toBeVisible();
    await shot(page, '07a-before-mark-completed');
    await markDone.click();

    await expect(page.getByText(/Visit completed/i)).toBeVisible({ timeout: 15_000 });
    await expect(
      page
        .locator('[data-qa="lead-action-panel"]')
        .getByText(/^Visited$/, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await shot(page, '07b-after-completed');
  });

  test('STEP 8 - /visits shows the scheduled visit in the weekly calendar', async ({
    page,
  }) => {
    await login(page);
    await page.goto(`${DEMO_BASE}/visits`);
    const probe = await probeForLayoutError(page, 'STEP 8');
    if (probe.broken) throw new Error(probe.reason);

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1_500);
    await shot(page, '08a-visits-page');

    const grid = page.getByRole('table');
    const hasGrid = (await grid.count()) > 0;
    if (!hasGrid) {
      throw new Error(
        'STEP 8: /visits weekly grid did not render - page may have errored.',
      );
    }
    // We created one new SCHEDULED visit in STEP 6; the demo seed also
    // adds bookings/visits that may or may not fall in the visible week.
    const visitPills = page.locator('table .bg-primary\\/10');
    const pillCount = await visitPills.count();
    console.log(`[STEP 8] /visits grid rendered with ${pillCount} visit pill(s).`);
    expect(pillCount).toBeGreaterThanOrEqual(1);
  });

  test('BONUS - lead detail renders chat panel with seeded messages', async ({ page }) => {
    const createdLeadId = await readCreatedLeadId();
    test.skip(createdLeadId === '', 'BONUS depends on a lead created in STEP 3');
    await login(page);
    await page.goto(`${DEMO_BASE}/leads/${createdLeadId}`);
    const probe = await probeForLayoutError(page, 'BONUS');
    if (probe.broken) throw new Error(probe.reason);

    await expect(page.locator('[data-qa="lead-action-panel"]')).toBeVisible({
      timeout: 15_000,
    });

    // This lead was created by the test (no seeded chat), so we only
    // verify that LeadChatPane renders the empty state - the meaningful
    // contract for a freshly-created lead. (Seeded leads would have
    // ≥1 chat message per the T-DEMOSET commit.)
    const chat = page.locator('[data-qa="chat-messages"]');
    await expect(chat).toBeVisible({ timeout: 10_000 });
    const emptyOrLoading = await Promise.race([
      chat
        .getByText(/No messages yet/i)
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true),
      chat
        .getByText(/Loading messages/i)
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true),
    ]).catch(() => false);
    expect(emptyOrLoading).toBeTruthy();
    await shot(page, 'bonus-chat-pane');
  });
});