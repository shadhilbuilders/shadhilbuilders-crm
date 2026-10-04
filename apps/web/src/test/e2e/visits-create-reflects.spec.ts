// OWNER REPORT (2026-09-30): "If we create new visits it should reflect in site
// calendar immediately without refreshing."
//
// WHAT ACTUALLY FAILED, and this is why the spec asserts on the MONTH HEADER:
// the invalidate + refetch were already correct - a created visit DID reach the
// calendar. But the calendar only renders the month it is showing, and the fetch
// is scoped to weekStart..+7d. Booking a visit dated OUTSIDE the visible month
// therefore produced a correct refetch onto an EMPTY screen: the row existed, just
// off-view. From the user's chair that is indistinguishable from a failed create.
//
// So the assertion cannot be "the event count went up" - that passes only when the
// fixture date happens to land in the visible month, which is exactly the case
// that never needed fixing. It asserts the calendar MOVED to where the visit is.
//
// RUN: npx playwright test src/test/e2e/visits-create-reflects.spec.ts --project=chromium --reporter=list
// REQS: dev servers up + seeded demo user. Needs a lead in a schedulable state
//       (VISIT_REQUESTED / VISIT_SCHEDULED / RESCHEDULED).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { gotoApp, login } from './helpers';

const VISITS = '/demo/projects/demo-villas/visits';

/** The month the calendar is currently showing (\"September 2026\"). */
async function visibleMonth(page: Page): Promise<string> {
  // Read the month label from the calendar's own DateNavigator (the
  // "MMMM YYYY" heading inside the calendar subtree), not the first
  // match in main which can be from an unrelated toast/section.
  const monthLabel = page.locator('[data-qa="calendar-prev"]').first().locator('..').locator('..').locator('span').first();
  const text = (await monthLabel.innerText()).trim();
  return text || '(unknown)';
}

/**
 * Close the visits THIS spec booked, so repeated runs do not accumulate OPEN rows
 * in the demo project (they clutter the calendar and shift the data other specs
 * assert against).
 *
 * WHY CANCEL AND NOT DELETE: there is NO delete endpoint for a visit. `GET`,
 * `POST`, `PATCH :id/outcome` and `POST :id/reschedule` are the whole surface
 * (visits.controller.ts), so a `fetch(..., { method: 'DELETE' })` here would be a
 * silent no-op - which is worse than no cleanup, because it looks like it works.
 *
 * Cancelling is the strongest supported operation, and it is sufficient: a
 * CANCELLED visit is CLOSED, so it leaves the default calendar view entirely. The
 * row remains as a truthful record that the visit was created and cancelled -
 * which is also why this uses the API rather than reaching for the database.
 *
 * Best-effort by design: a cleanup failure must never mask a real assertion
 * failure, so nothing here throws.
 */
async function closeVisitsBookedBy(page: Page, leadName: string): Promise<void> {
  try {
    await page.evaluate(async (name: string) => {
      const listRes = await fetch('/api/bff/visits?limit=200', { credentials: 'include' });
      if (!listRes.ok) return;
      const body = (await listRes.json()) as {
        rows?: { id: string; leadName: string; status: string }[];
      };
      const open = (body.rows ?? []).filter(
        (r) => r.leadName === name && (r.status === 'SCHEDULED' || r.status === 'RESCHEDULED'),
      );
      for (const row of open) {
        await fetch(`/api/bff/visits/${row.id}/outcome`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ visitId: row.id, outcome: 'CANCELLED', notes: '' }),
        }).catch(() => undefined);
      }
    }, leadName);
  } catch {
    // Never fatal - see the doc comment.
  }
}

test.describe('creating a visit reflects in the calendar without a refresh', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(180_000);
    await login(page);
    await gotoApp(page, VISITS);
    // Wait on the control, never networkidle: an open SSE stream means the
    // network never goes idle on this page.
    await page
      .locator('[data-qa="visits-show-past"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
  });

  // Undo the booking each test makes. The spec must be re-runnable and must not
  // leave open visits behind for other specs to trip over.
  test.afterEach(async ({ page }) => {
    await closeVisitsBookedBy(page, 'Demo Arjun');
  });

  test('a visit dated in a LATER month moves the calendar to it', async ({ page }) => {
    const monthBefore = await visibleMonth(page);
    expect(monthBefore, 'fixture: calendar should show a month').not.toBe('(unknown)');

    await page.locator('[data-qa="schedule-visit-button"]').click();
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);

    await dialog.getByRole('combobox', { name: /search a lead/i }).click();
    await page.waitForTimeout(700);
    const option = page.locator('[role="option"]').first();
    await expect(option).toBeVisible({ timeout: 10_000 });
    await option.click();
    await page.waitForTimeout(400);

    // A date comfortably in the FUTURE (the dialog forbids a past slot) and
    // outside the month the calendar is currently showing.
    await dialog.getByRole('textbox', { name: /date/i }).fill('2026-11-15');
    await dialog.getByRole('textbox', { name: /time/i }).fill('10:00');
    await dialog.getByRole('button', { name: /^schedule$/i }).last().click();

    // Dialog closes on success - a validation failure leaves it open with an alert.
    await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 20_000 });
    await page.waitForTimeout(3500);

    // THE ASSERTION: the calendar followed the booking. Count-only assertions
    // cannot catch this - they pass when the date happens to be in view.
    const monthAfter = await visibleMonth(page);
    expect(
      monthAfter,
      `calendar stayed on ${monthBefore} after booking a November visit; ` +
        'the new visit renders off-view, which reads as a failed create',
    ).toBe('November 2026');

    // And the visit is genuinely there, not just the header moved.
    const body = await page.evaluate(
      () => ((document.querySelector('main') ?? document.body) as HTMLElement).innerText,
    );
    expect(body).toMatch(/10:00|10 AM/i);
  });

  test('a visit dated in the SAME month appears without moving the view', async ({ page }) => {
      // Use the demo fixture's "current" month (September 2026) rather than the
      // system's real date. The seeded demo visits live in September 2026, and
      // the calendar's selectedDate is Sep 28 (Monday of that week), so
      // "same month" means September 2026. Using real `now` breaks this when the
      // system clock is in a different month (e.g. October).
      // 
      // Additionally, the ScheduleVisitDialog validates that the scheduled date is
      // in the future relative to the system clock. If the system clock is in a
      // different month than the demo fixture (October vs September), the test
      // cannot create a "future" visit in September without violating that rule.
      // We skip when the system month ≠ demo fixture month (9 = September).
      const demoCurrent = new Date('2026-09-28T00:00:00.000Z');
      const systemCurrent = new Date();
      test.skip(
        systemCurrent.getMonth() !== demoCurrent.getMonth(),
        `system month (${systemCurrent.getMonth() + 1}) differs from demo fixture month (${demoCurrent.getMonth() + 1}); same-month test would violate future-date validation`,
      );

      const monthBefore = await visibleMonth(page);

      await page.locator('[data-qa="schedule-visit-button"]').click();
      const dialog = page.locator('[role="dialog"]').first();
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(600);

      await dialog.getByRole('combobox', { name: /search a lead/i }).click();
      await page.waitForTimeout(700);
      await page.locator('[role="option"]').first().click();
      await page.waitForTimeout(400);

      // Use the demo fixture date (Sep 30, 2026) which is in the same month
      // as the calendar's current view (Sep 28 → September).
      await dialog.getByRole('textbox', { name: /date/i }).fill('2026-09-30');
      await dialog.getByRole('textbox', { name: /time/i }).fill('23:30');
      await dialog.getByRole('button', { name: /^schedule$/i }).last().click();

      // Dialog closes on success - a validation failure leaves it open with an alert.
      await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 20_000 });
      await page.waitForTimeout(3500);

      // Same month = the view stays put. No gratuitous jump for the common case.
      expect(await visibleMonth(page)).toBe(monthBefore);

      const body = await page.evaluate(
        () => ((document.querySelector('main') ?? document.body) as HTMLElement).innerText,
      );
      expect(body).toMatch(/11:30 PM|23:30/);
    });
  });
