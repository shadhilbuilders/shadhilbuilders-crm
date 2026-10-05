// Visits "Show past visits" toggle - REAL browser (2026-09-29).
//
// WHY THIS EXISTS: the toggle was swapped from a raw <input type="checkbox"> to
// the design-system Switch. A green compile proves nothing about the two things
// that actually break here:
//   1. It must render as a real `role="switch"` control (Base UI), not a leftover
//      checkbox - otherwise the swap silently did not happen.
//   2. Flipping it must change what the CALENDAR renders. The toggle is a pure
//      filter over already-fetched rows, so a wiring mistake renders a Switch that
//      moves but filters nothing - invisible to a render-only assertion.
//
// ASSERTION IS BEHAVIOURAL, ON THE CALENDAR'S OWN EVENT COUNT. This spec originally
// counted `[data-qa^="visit-entry"]` nodes, which matched NOTHING the calendar
// actually emits, so both modes returned 0 and the test passed vacuously (0 >= 0)
// while the feature was in fact broken by a stale `useMemo` dependency (see
// site-visit-calendar.tsx: `events` was keyed on `visitsQuery.data` instead of the
// filtered `rows`, so the toggle recomputed `rows` and never re-rendered `events`).
// It now reads the "<n> events" tally the calendar itself displays and requires a
// strict INCREASE, so "the filter does nothing" fails loudly instead of silently.
//
// DATA REQUIREMENT: the seeded demo project needs at least one CLOSED visit
// (completed / no-show / cancelled) inside the visible month. Without one, ON and
// OFF render identical counts and the assertion fails with a message saying which.
//
// RUN:  npx playwright test src/test/e2e/visits-show-past-toggle.spec.ts --project=chromium --reporter=list
// REQS: dev servers up (web :3000, backend :8080) + the seeded demo user.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { gotoApp, login } from './helpers';

const VISITS = '/demo/projects/demo-villas/visits';

/**
 * Wait until the page has settled, WITHOUT `waitForLoadState('networkidle')`.
 *
 * That call is a trap on this page: the notifications surface holds an open SSE
 * stream (`/api/sse/notifications`), so the network never goes idle and the
 * helper times out after 30s - looking exactly like a broken feature when the
 * page is in fact fully rendered. Waiting on the toggle itself is both faster and
 * a stronger precondition, since every test here needs that control anyway.
 */
async function settled(page: Page): Promise<void> {
  await page.locator('[data-qa="visits-show-past"]').first().waitFor({
    state: 'visible',
    timeout: 30_000,
  });
  // The switch is in the server HTML, so it is visible BEFORE React hydrates;
  // a click/keypress then is silently dropped. The calendar header only mounts
  // client-side once the visits query resolves, so it is a hydration signal.
  await page.locator('[data-qa="calendar-prev"]').first().waitFor({
    state: 'visible',
    timeout: 30_000,
  });
}

/**
 * The calendar's own visible event tally, POLLED until it stabilises.
 *
 * A plain read races the visits query: the toggle renders before the data lands,
 * so an immediate read returns 0 and the comparison becomes meaningless (that
 * flake is exactly how this helper earned its poll). Waiting for the same value
 * twice in a row means the fetch has settled without assuming a fixed delay.
 */
async function eventCount(page: Page): Promise<number> {
  const read = () =>
    page.evaluate(() => {
      const t = ((document.querySelector('main') ?? document.body) as HTMLElement).innerText;
      const m = /(\d+)\s+events?\b/i.exec(t);
      return m?.[1] !== undefined ? Number(m[1]) : 0;
    });

  let last = await read();
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(150);
    const next = await read();
    if (next === last && next > 0) return next; // settled on a real number
    if (next === last && last === 0 && i > 6) return next; // genuinely empty
    last = next;
  }
  return last;
}

test.describe('visits - Show past visits uses the Switch component', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await gotoApp(page, VISITS);
    await settled(page);
  });

  test('renders a real role=switch control (not a checkbox)', async ({ page }) => {
    const toggle = page.locator('[data-qa="visits-show-past"]').first();
    await expect(toggle).toBeVisible();

    // THE POINT OF THE CHANGE: it must be the design-system Switch.
    await expect(toggle).toHaveAttribute('role', 'switch');

    // And it must NOT be the old checkbox.
    await expect(toggle).not.toHaveAttribute('type', 'checkbox');

    // Accessible name comes from the visible <Label> (Switch id + Label htmlFor),
    // so the control must be reachable BY NAME. Asserted through the a11y tree
    // rather than a `label[for]` lookup: Base UI associates the two without
    // necessarily emitting a literal for= attribute, and an unnamed switch is the
    // real accessibility regression to catch.
    await expect(page.getByRole('switch', { name: /show past visits/i })).toHaveCount(1);

    // No duplicate announcement: the old <input> had no name either, so ADDING an
    // aria-label on top of the visible label would be the new bug.
    expect(await toggle.getAttribute('aria-label')).toBeNull();
  });

  test('flipping it changes how many visits the calendar renders', async ({ page }) => {
    const toggle = page.locator('[data-qa="visits-show-past"]').first();
    await expect(toggle).toBeVisible();

    // Owner direction: the default view is UPCOMING only.
    await expect(toggle).toHaveAttribute('data-unchecked', '');
    const upcomingOnly = await eventCount(page);

    await toggle.click();

    // The control must actually change state.
    await expect(toggle).toHaveAttribute('data-checked', '');
    await page.waitForTimeout(700);
    const withHistory = await eventCount(page);

    // THE BEHAVIOURAL ASSERTION. Strictly greater proves the toggle is wired
    // through to the calendar AND that the events memo re-derives - the exact bug
    // this caught. Equality means either no closed visits are in view or the filter
    // is broken; fail, and the message says which.
    expect(
      withHistory,
      'toggling "Show past visits" did not change the rendered event count ' +
        `(${upcomingOnly} -> ${withHistory}). Either the demo project has no CLOSED ` +
        'visit in the visible month, or the toggle is not wired to the calendar.',
    ).toBeGreaterThan(upcomingOnly);

    // Flip back - the switch must be two-way, not a latch.
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-unchecked', '');
    await page.waitForTimeout(700);
    expect(await eventCount(page)).toBe(upcomingOnly);
  });

  test('is keyboard operable (Space activates it)', async ({ page }) => {
    const toggle = page.locator('[data-qa="visits-show-past"]').first();
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('data-checked', '');
  });
});

/**
 * OWNER DIRECTION (2026-09-30): "Exclude terminal-lead visits from the default
 * view (revealed by Show past visits)".
 *
 * The production bug this pins: a WON lead kept an OPEN visit (nothing closes a
 * win's visit - the handover may still be owed), and the calendar only ever asked
 * the VISIT's status, so that row rendered as live work forever.
 *
 * Asserted on NAMES, not counts. A count-only assertion cannot tell "the won
 * deal's visit was excluded" from "some other row went missing"; naming the
 * expected lead is what makes this a test of the actual rule.
 *
 * REQUIRES the seeded demo data: `demo-visit-upcoming-1` on a live lead, and
 * `demo-visit-past-1` re-pointed at a WON lead. If the fixture is missing, this
 * fails loudly rather than passing on an empty calendar.
 */
test.describe('visits - a settled deal\'s visit is not upcoming work', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await gotoApp(page, VISITS);
    await settled(page);
  });

  /**
   * The calendar's rendered text, WAITED ON rather than read immediately.
   *
   * `settled()` only waits for the toggle to mount, which happens before the
   * visits query resolves - so a direct read can catch the agenda mid-fetch and
   * see "0 events". That race is what made this test pass in isolation and fail
   * when run after a sibling spec (the extra load widens the window); the page
   * snapshot from a failing run showed "5 events" with the expected lead present,
   * i.e. the data was always fine and the read was early.
   *
   * Waits for a non-empty agenda instead of a fixed sleep: the day-group headings
   * only render once events exist.
   */
  async function calendarText(page: Page): Promise<string> {
    await page
      .locator('main p')
      .filter({ hasText: /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),/ })
      .first()
      .waitFor({ state: 'attached', timeout: 20_000 })
      .catch(() => undefined);
    return page.evaluate(
      () => ((document.querySelector('main') ?? document.body) as HTMLElement).innerText,
    );
  }

  test('hides a WON lead\'s open visit by default, and reveals it under Show past', async ({
    page,
  }) => {
    const toggle = page.locator('[data-qa="visits-show-past"]').first();
    await expect(toggle).toHaveAttribute('data-unchecked', '');

    const off = await calendarText(page);
    // The live deal's visit IS upcoming work - it must be there, or the assertion
    // below would pass simply because nothing rendered.
    expect(off, 'live lead\'s visit should be in the default view').toContain('Demo Meera');
    // The settled deal's open visit is NOT. This is the fix.
    // The seeded WON lead is Demo Vikram (see setup-demo-user.ts DEMO_LEAD_WON).
    expect(off, 'a WON lead\'s open visit must not read as upcoming').not.toContain(
      'Demo Vikram',
    );

    await toggle.click();
    await expect(toggle).toHaveAttribute('data-checked', '');
    await page.waitForTimeout(700);

    const on = await calendarText(page);
    // Reachable, not deleted: history still holds it.
    expect(on, 'Show past must reveal the settled deal\'s visit').toContain('Demo Vikram');
  });
});
