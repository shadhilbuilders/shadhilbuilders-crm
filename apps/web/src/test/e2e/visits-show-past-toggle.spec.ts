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

const DEMO_EMAIL = 'demo@shadhilbuilders.in';
const DEMO_PASSWORD = 'demo123';
const VISITS = '/demo/projects/demo-villas/visits';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('input#email, input[name="email"]').fill(DEMO_EMAIL);
  await page.locator('[data-qa="login-password"]').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
}

/**
 * The calendar's own visible event tally ("2 events" / "1 event" / "0 events"),
 * read from rendered text. Deliberately NOT a CSS-selector node count: the earlier
 * selector-based version matched no node at all and made this spec vacuous.
 */
async function eventCount(page: Page): Promise<number> {
  const text = await page.evaluate(
    () => ((document.querySelector('main') ?? document.body) as HTMLElement).innerText,
  );
  const m = /(\d+)\s+events?\b/i.exec(text);
  return m?.[1] !== undefined ? Number(m[1]) : 0;
}

test.describe('visits - Show past visits uses the Switch component', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto(VISITS);
    await page.waitForLoadState('networkidle');
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
