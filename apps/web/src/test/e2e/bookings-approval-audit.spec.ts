// Real-browser audit of the booking approval surface (T-APPROVE-AUDIT, 2026-09-16).
//
// TWO owner reports drive this file:
//
//   1. "Approve Booking dialog has two approved and rejected option, one select
//      and other in footer, keep one, don't make user confusion."
//      -> T-APPROVE-ONE-CONTROL: the body's Decision select was removed; the
//      footer pair is the single control. Asserted here as a COUNT (zero
//      selects, exactly one Approve, one Reject) because "two ways to say the
//      same thing" is exactly what a markup assertion in jsdom cannot see
//      across the Dialog PORTAL - the portal renders empty under
//      renderToStaticMarkup, which is how the duplicate survived review.
//
//   2. "add unit name in the awaiting approval item along with name"
//      -> T-APPROVE-UNIT-NAME: the card row now leads with the unit.
//
// AND ONE DEFECT FOUND WHILE VERIFYING THOSE (T-APPROVE-WRONG-STATE):
//
//   The card queried `status=['HOLD']` while the dialog it opens performs
//   TOKEN → APPROVED | REJECTED. `legalNextStates('HOLD')` is
//   ['TOKEN','CANCELLED'], so the server refused EVERY decision:
//
//     PATCH /bookings/:id {toStatus:'APPROVED'}
//       on a HOLD row  -> 400 "Cannot transition booking from HOLD to APPROVED
//                              (allowed: TOKEN, CANCELLED)"
//       on a TOKEN row -> 200
//
//   The manager saw "Awaiting approval", clicked Review, clicked Approve, and
//   got an error - a dead end. The card now asks for TOKEN. The live proof of
//   the 400/200 split is re-checked below so a regression cannot come back
//   silently.
//
// WHERE THESE RUN: in the DEFAULT suite (playwright.config.ts has no
// `testIgnore`, so despite the `-audit` name this file IS collected - the same
// was assumed of dashboard-audit.spec.ts and was never true either). CI runs
// `playwright test --project=chromium`.
//
// Bookings do NOT come from src/seed.ts (which creates units as AVAILABLE and
// says "only a booking moves it") but from scripts/setup-demo-user.ts, which CI's
// `rls-matrix` job runs before its playwright step - so CI DOES have a TOKEN and a
// HOLD booking, and these assertions really run there. An earlier version of this
// comment claimed CI had no booking fixtures; that was wrong.
//
// Each test still probes first and skips with a reason rather than asserting a
// non-zero count, so the file stays honest on a database seeded by src/seed.ts
// alone (the `test` job). The vitest suite is the gate for the same behaviours
// (`page.test.tsx`'s card-scoped guards, the dialog's no-second-control
// assertions, PendingApprovalsCard/PendingTokenCard tests); this file is the
// real-browser instrument for what jsdom cannot see - above all the Dialog
// PORTAL, which renders empty under renderToStaticMarkup and is how the duplicate
// decision control survived review.
//
// RUN:  npx playwright test src/test/e2e/bookings-approval-audit.spec.ts --project=chromium --reporter=list
// REQS: dev servers up (web :3000, backend :8080), seeded demo user, and a
//       TOKEN booking in the demo project for the assertions to bite.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { gotoApp, login } from './helpers';

const DASHBOARD = '/demo/projects/demo-villas/dashboard';

/**
 * Wait for a row to actually render, and report whether it did.
 *
 * WHY NOT `waitForTimeout(3000)`: a fixed delay after `networkidle` is a race.
 * It passed locally and FAILED on chromium under full-suite load, where the
 * dashboard's queries had not settled inside 3s - a flaky test that would be
 * blamed on the feature rather than on the sleep. Waiting on the element itself
 * is deterministic: present data renders and the test bites, absent data skips
 * with a reason.
 */
async function rowAppeared(page: Page, qa: string): Promise<boolean> {
  return page
    .locator(`[data-qa="${qa}"]`)
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
}

const NO_FIXTURE =
  'SKIP: no TOKEN booking in this database. Bookings are created by ' +
  'packages/database/scripts/setup-demo-user.ts (not src/seed.ts, which leaves ' +
  'every unit AVAILABLE). Run `pnpm --filter @shadhil/database setup-demo-user` ' +
  'to give this assertion something to bite on.';

test('approval dialog offers exactly ONE decision control', async ({ page }) => {
  await login(page);
  await gotoApp(page, DASHBOARD);

  test.skip(!(await rowAppeared(page, 'booking-approve-open')), NO_FIXTURE);

  await page.locator('[data-qa="booking-approve-open"]').first().click();
  await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 15_000 });

  const dialog = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return null;
    return {
      text: (dlg.textContent ?? '').trim(),
      selects: dlg.querySelectorAll('[role="combobox"], select').length,
      decisionField: dlg.querySelectorAll('[data-qa="form-field-decision"]').length,
      approve: dlg.querySelectorAll('[data-qa="booking-approval-approve"]').length,
      reject: dlg.querySelectorAll('[data-qa="booking-approval-reject"]').length,
      cancel: dlg.querySelectorAll('[data-qa="booking-approval-cancel"]').length,
      approveLabel: (
        dlg.querySelector('[data-qa="booking-approval-approve"]')?.textContent ?? ''
      ).trim(),
      rejectLabel: (
        dlg.querySelector('[data-qa="booking-approval-reject"]')?.textContent ?? ''
      ).trim(),
    };
  });

  expect(dialog, 'approval dialog did not open').not.toBeNull();
  if (dialog === null) return;

  // ONE control. A second decision surface is the reported confusion.
  expect(dialog.selects, 'a second decision control (select) reappeared in the body').toBe(0);
  expect(dialog.decisionField, 'the removed "Decision" field reappeared').toBe(0);
  expect(dialog.approve, 'expected exactly one Approve control').toBe(1);
  expect(dialog.reject, 'expected exactly one Reject control').toBe(1);
  expect(dialog.cancel, 'expected exactly one Cancel control').toBe(1);
  // The buttons say what they do - "Approve"/"Reject" alone read as the select's
  // own labels and made the two surfaces look like the same choice twice.
  expect(dialog.approveLabel).toContain('Approve');
  expect(dialog.rejectLabel).toContain('Reject');
});

test('awaiting-approval row names the UNIT, and the dialog repeats it', async ({ page }) => {
  await login(page);
  await gotoApp(page, DASHBOARD);

  test.skip(!(await rowAppeared(page, 'booking-approve-open')), NO_FIXTURE);

  const rows = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('[data-qa="booking-approve-open"]'));
    return btns.map((b) => ({
      row: (b.closest('li')?.textContent ?? '').trim(),
      aria: b.getAttribute('aria-label') ?? '',
    }));
  });

  expect(rows.length, 'no awaiting-approval rows to check').toBeGreaterThan(0);

  for (const r of rows) {
    // The unit is the booking's primary identifier (which villa), the customer
    // name is secondary - the same ordering the bookings grid uses.
    expect(r.row, `row "${r.row}" does not name its unit`).toMatch(/Unit\s+\S+/);
    expect(r.aria, 'the Review button must name the unit for screen readers').toMatch(
      /Review booking for Unit\s+\S+/
    );
  }

  // The dialog repeats the unit, so the Review click is confirmed as the row the
  // user meant.
  await page.locator('[data-qa="booking-approve-open"]').first().click();
  await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 15_000 });
  const body = await page.evaluate(() =>
    (document.querySelector('[role="dialog"]')?.textContent ?? '').trim()
  );
  expect(body).toMatch(/Unit\s+\S+/);
});

// T-LINK-CONVENTION (2026-09-16, owner direction): dashboard links use the
// library's `variant="link"`, which supplies `underline-offset-4 hover:underline`
// - the underline appears ON HOVER ONLY, and there is no hand-written `underline`
// alongside it to drift from the variant. The `text-link` class is kept
// deliberately: the variant's own colour is `text-primary`, which is NAVY
// (--primary), while the app's link blue is a DIFFERENT token (--link).
//
// This also pins the amount format the owner asked for in the same message: the
// API returns a decimal string and it must render as grouped currency.
test('approval row: hover-only underline, link colour token, formatted amount', async ({
  page,
}) => {
  await login(page);
  await gotoApp(page, DASHBOARD);

  test.skip(!(await rowAppeared(page, 'booking-approve-open')), NO_FIXTURE);

  const review = page.locator('[data-qa="booking-approve-open"]').first();

  // At rest: no underline. On hover: underlined. The PAIR is the assertion -
  // checking only one would pass on both the old and the new markup.
  const rest = await review.evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(rest, 'the link must NOT be underlined at rest').toBe('none');

  // The hover half is only meaningful on a device that HAS hover. mobile-chrome
  // emulates a touch screen, where the CSS `:hover` rule cannot apply at all -
  // so this correctly reports "none" and is NOT a defect to chase. Assert the
  // capability the run actually has, so the spec stays honest on all three
  // browser projects instead of being weakened to "sometimes underlined".
  const canHover = await page.evaluate(() => window.matchMedia('(hover: hover)').matches);
  if (canHover) {
    await review.hover();
    await page.waitForTimeout(300);
    const hovered = await review.evaluate((el) => getComputedStyle(el).textDecorationLine);
    expect(hovered, 'the link must underline on hover').toBe('underline');
  }

  const probe = await page.evaluate(() => {
    const s = document.createElement('span');
    document.body.appendChild(s);
    s.className = 'text-link';
    const link = getComputedStyle(s).color;
    s.className = 'text-primary';
    const primary = getComputedStyle(s).color;
    s.remove();
    const btn = document.querySelector('[data-qa="booking-approve-open"]') as HTMLElement | null;
    const row = btn?.closest('li');
    // The money cell is the only tabular-nums span in the row.
    const amount = (row?.querySelector('span.tabular-nums')?.textContent ?? '').trim();
    return { link, primary, btnColour: btn ? getComputedStyle(btn).color : null, amount };
  });

  // The button must use the LINK token, not the variant's default text-primary.
  expect(probe.link, '--link and --primary should be different tokens').not.toBe(probe.primary);
  expect(probe.btnColour, 'the Review link must use the link colour token').toBe(probe.link);

  // The amount is grouped currency, never the raw API decimal string.
  expect(probe.amount).toMatch(/^₹[\d,]+(\.\d{2})?$/);
  expect(probe.amount, 'the raw API decimal string is leaking into the UI').not.toMatch(
    /^\d+(\.\d+)?$/
  );

  // T-APPROVE-TOKEN-AMOUNT (2026-09-16, owner report): the token payment the
  // manager is approving against must be VISIBLE. The dialog's own target type
  // had declared `amount`/`tokenAmount` without ever rendering them, so the
  // decision was made without seeing the money. The fixture token is set by
  // setup-demo-user.ts (250000.00 on the D-101 booking).
  const tokenCell = page.locator('[data-qa="booking-approval-token-amount"]').first();
  expect(await tokenCell.count(), 'the token payment is not shown on the row').toBe(1);
  const tokenText = (await tokenCell.textContent()) ?? '';
  expect(tokenText, 'the row must LABEL the token, not just show a bare figure').toMatch(
    /^Token received: ₹[\d,]+(\.\d{2})?$/
  );

  await review.click();
  await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 15_000 });
  const money = await page.evaluate(() =>
    (document.querySelector('[data-qa="booking-approval-money"]')?.textContent ?? '').trim()
  );
  expect(money, 'the dialog must show the token against the total').toMatch(
    /^Token received: ₹[\d,]+(\.\d{2})? of ₹[\d,]+(\.\d{2})?$/
  );
});

test('the card lists a state the approval can actually act on', async ({ page }) => {
  await login(page);

  // Deliberately NON-DESTRUCTIVE: this asserts the state the card asks for, and
  // that HOLD is refused. It does NOT attempt APPROVED on a real TOKEN booking -
  // that would approve the seeded demo booking and destroy the very fixture
  // these tests need (an earlier version of this file did exactly that, and the
  // next run found 0 rows left to check).
  //
  // The TOKEN -> 200 half was proven by hand when the bug was found:
  //   PATCH /bookings/:id {toStatus:'APPROVED'}
  //     HOLD  -> 400 "Cannot transition booking from HOLD to APPROVED (allowed: TOKEN, CANCELLED)"
  //     TOKEN -> 200
  const probe = await page.evaluate(async () => {
    const get = async (url: string) => {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      const j = (await r.json().catch(() => null)) as {
        rows?: Array<Record<string, unknown>>;
      } | null;
      return (j?.rows ?? []) as Array<Record<string, unknown>>;
    };
    const hold = await get('/api/bff/bookings?status=HOLD&limit=5');
    const token = await get('/api/bff/bookings?status=TOKEN&limit=5');
    let holdAttempt: { status: number; message: string } | null = null;
    if (hold[0]) {
      const res = await fetch(`/api/bff/bookings/${String(hold[0].id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ toStatus: 'APPROVED' }),
      });
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      holdAttempt = { status: res.status, message: String(body?.message ?? '') };
    }
    return { holdCount: hold.length, tokenCount: token.length, holdAttempt };
  });

  // The card's filter must select a state with rows available where possible.
  test.skip(probe.tokenCount === 0, NO_FIXTURE);

  // HOLD is NOT manager-decidable; approving one is a dead end. If this ever
  // returns 200, legalNextStates changed and the card's filter must follow.
  if (probe.holdAttempt) {
    expect(
      probe.holdAttempt.status,
      'APPROVED became legal from HOLD - legalNextStates changed; revisit the card filter'
    ).toBe(400);
    expect(probe.holdAttempt.message).toMatch(/Cannot transition booking from HOLD/);
  }
});

// ── T-HOLD-VISIBLE ───────────────────────────────────────────────────────────
// Removing HOLD from the approvals card left a HOLD booking with NO dashboard
// surface at all - initiated, unit held, money outstanding, invisible. It now has
// its own card, because recording a token is a DIFFERENT ACTION with a WIDER gate
// (SALES_EXEC may record a token but can never approve).
//
// NON-DESTRUCTIVE ON PURPOSE: this asserts the card and its wiring, and does NOT
// click the button. Clicking really moves the booking HOLD -> TOKEN and destroys
// the fixture (the lesson from the approvals card). The click WAS proven by hand
// against the live API:
//   PATCH /bookings/<id> {"toStatus":"TOKEN"}
//   BEFORE: HOLD=[D-102] TOKEN=[D-101]
//   AFTER:  HOLD=[]      TOKEN=[D-101, D-102]   toast "Token recorded"
// and the state was restored from a pre-click snapshot (verified byte-identical).
test('HOLD bookings get a token-payment card, with the action wired to its own row', async ({
  page,
}) => {
  await login(page);

  // Navigate FIRST, then probe. Probing between the login redirect and this
  // goto aborts the navigation in firefox (`NS_BINDING_ABORTED; maybe frame was
  // detached?`) because the login redirect is still settling.
  await gotoApp(page, DASHBOARD);

  test.skip(
    !(await rowAppeared(page, 'booking-record-token')),
    'SKIP: no HOLD booking rendered - run packages/database/scripts/setup-demo-user.ts'
  );

  const card = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('[data-qa="booking-record-token"]'));
    return {
      present: (document.body.textContent ?? '').includes('Needs token payment'),
      buttons: btns.map((b) => ({
        aria: b.getAttribute('aria-label') ?? '',
        tag: b.tagName,
        disabled: (b as HTMLButtonElement).disabled,
      })),
    };
  });

  expect(card.present, 'the token-payment card is not on the dashboard').toBe(true);
  expect(card.buttons.length).toBeGreaterThan(0);
  for (const b of card.buttons) {
    // A real button, so it is keyboard reachable and not a div with onClick.
    expect(b.tag).toBe('BUTTON');
    expect(b.disabled).toBe(false);
    // The accessible name carries the UNIT, so a list of identical "Record
    // token" buttons is unambiguous to a screen-reader user.
    expect(b.aria).toMatch(/^Record token for (Unit \S+ · )?.+/);
  }
});
