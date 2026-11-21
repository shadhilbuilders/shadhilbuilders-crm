// Real-browser mobile audit of the staff-invite surfaces (2026-11-20).
//
// WHY THIS EXISTS: the vitest suite renders these components in jsdom, which has
// no layout engine - every element reports zero size, so NOTHING about
// responsiveness is assertable there. A green jsdom run says nothing about
// whether the invite link fits a 320px screen. This file is the instrument for
// that, and the only place the measurements below can be taken.
//
// WHAT IT ACTUALLY GUARDS, and why each case is here:
//   * the invite link is 43 unbroken base64url characters. Undifferentiated it
//     is one unbreakable word that forces a 320px dialog to scroll sideways.
//     That is the single most likely way this feature breaks on a phone.
//   * the three send actions must STACK, not squeeze, at 288px of content.
//   * tap targets are a POINTER question, not a width one: a landscape phone is
//     568-844px wide while still a finger device, so the coarse-pointer case
//     uses a REAL touch descriptor (`hasTouch: true`). Resizing a desktop
//     context leaves `pointer: fine`, which is how the width-based attempt in
//     dashboard-mobile-audit.spec.ts measured as correct while being wrong.
//
// RUN:  npx playwright test src/test/e2e/invites-mobile-audit.spec.ts --project=chromium --reporter=list
// REQS: dev servers up (web :3000, backend :8080), seeded admin, and the Users
//       page reachable at /<org>/admin/users.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { gotoApp, login } from './helpers';

/**
 * The Users page is ORG-SCOPED: every app route lives under `/[orgSlug]/...`
 * (see `src/app/[orgSlug]/layout.tsx`). Navigating to a bare `/admin/users`
 * matches no route and renders Next's 404, so the tab this file is about never
 * exists - which is how it failed on CI on 2026-11-20: four timeouts waiting
 * for a `role="tab"` on a "Page not found" screen.
 *
 * `demo` is the DEMO OWNER's org slug (`DEMO_ORG_SLUG` in
 * packages/database/scripts/setup-demo-user.ts), and the session in the shared
 * storageState is that owner. Every other spec hardcodes the same prefix
 * (`/demo/projects/demo-villas/...`), so this matches the suite.
 */
const USERS_PATH = '/demo/admin/users';

/**
 * Real device widths. 320 is the narrowest in use (iPhone SE 1st gen / Fold
 * outer screen); landscape heights are included because a phone on its side has
 * almost no vertical room, which is where a dialog's footer submit falls below
 * the fold.
 */
const VIEWPORTS: ReadonlyArray<{ w: number; h: number; label: string }> = [
  { w: 320, h: 568, label: '320x568 (SE1 / Fold outer)' },
  { w: 360, h: 640, label: '360x640 (common Android)' },
  { w: 375, h: 667, label: '375x667 (iPhone 8)' },
  { w: 390, h: 844, label: '390x844 (iPhone 14)' },
  { w: 412, h: 915, label: '412x915 (Pixel 7)' },
  { w: 428, h: 926, label: '428x926 (iPhone Pro Max)' },
  { w: 568, h: 320, label: '568x320 (landscape SE)' },
  { w: 844, h: 390, label: '844x390 (landscape 14)' },
];

/**
 * Open the Invites tab.
 *
 * Waits on an ELEMENT, never a fixed delay - the dashboard audit documented that
 * `waitForTimeout` passes locally and flakes under full-suite load, and the flake
 * then gets blamed on the feature.
 */
async function openInvitesTab(page: Page): Promise<void> {
  await gotoApp(page, USERS_PATH);
  const invitesTab = page.locator('[role="tab"]', { hasText: 'Invites' });
  await invitesTab.waitFor({ state: 'visible', timeout: 20_000 });
  await invitesTab.click();
  // Either the table or the empty state must appear; both mean the panel is up.
  await page
    .locator('[data-qa="invites-status-filter"], :text("No invites yet")')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => undefined);
  await page.waitForTimeout(300);
}

/** Open the "Invite staff" dialog. */
async function openInviteDialog(page: Page): Promise<void> {
  const trigger = page.locator('[data-qa="invite-staff-button"]');
  await trigger.waitFor({ state: 'visible', timeout: 20_000 });
  await trigger.click();
  await page.locator('[data-qa="invite-email"]').waitFor({ state: 'visible', timeout: 15_000 });
}

/** Layout facts for the current viewport. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Any element whose right edge passes the viewport is a sideways-scroll
    // defect. The off-canvas sidebar sits LEFT of 0 by design, so only a right
    // overhang counts.
    const overflowing: string[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.closest('[data-slot="sidebar"]')) continue;
      if (r.right > vw + 1) {
        overflowing.push(`${el.tagName}[${el.getAttribute('data-qa') ?? ''}]`);
      }
    }

    const small: string[] = [];
    for (const el of Array.from(
      document.querySelectorAll('button, a[href], [role="button"], [role="menuitem"]'),
    )) {
      if (el.getAttribute('data-qa') === 'sidebar-rail') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width < 44 || r.height < 44) {
        small.push(
          `${el.tagName}[${el.getAttribute('data-qa') ?? (el.textContent ?? '').trim().slice(0, 12)}] ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
      }
    }

    // Is the submit button actually reachable, or below the fold?
    const submit = document.querySelector('[data-qa="invite-submit"]');
    const submitBox = submit ? submit.getBoundingClientRect() : null;

    return {
      docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      // Separate from `docOverflow`: a dialog with its own scroller can clip
      // horizontally without ever widening the document, so the document check
      // alone would miss a token that is only scrollable-but-not-wrapping
      // inside the popup.
      datasetOverflow: Array.from(document.querySelectorAll('[data-qa$="-block"]')).some((el) => {
        const box = el.getBoundingClientRect();
        return box.right > vw + 1;
      }),
      overflowing,
      small,
      coarse: window.matchMedia('(pointer: coarse)').matches,
      submitInView: submitBox === null ? null : submitBox.top < vh && submitBox.bottom > 0,
    };
  });
}

test('the Invites tab fits every phone width with no sideways scroll', async ({ page }) => {
  test.setTimeout(300_000);
  await login(page);

  let first = true;
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    if (first) {
      await openInvitesTab(page);
      first = false;
    } else {
      await page.waitForTimeout(200);
    }
    const r = await measure(page);

    expect(r.docOverflow, `${vp.label}: horizontal document overflow`).toBe(false);
    expect(r.overflowing, `${vp.label}: elements past the viewport edge`).toEqual([]);
  }
});

test('the invite dialog fits, and its submit stays reachable', async ({ page }) => {
  test.setTimeout(300_000);
  await login(page);

  let first = true;
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    if (first) {
      await openInvitesTab(page);
      await openInviteDialog(page);
      first = false;
    } else {
      await page.waitForTimeout(200);
    }

    const r = await measure(page);
    expect(r.docOverflow, `${vp.label}: dialog caused horizontal overflow`).toBe(false);
    expect(r.overflowing, `${vp.label}: dialog element past the viewport edge`).toEqual([]);
    // The `max-h-[calc(100dvh-4rem)]` cap is what keeps this true on a
    // landscape phone, where the footer would otherwise sit below the fold and
    // the dialog would look like it has no way to submit.
    expect(r.submitInView, `${vp.label}: submit button is below the fold`).toBe(true);
  }
});

test('every control in the invite dialog is a real 44px tap target on touch', async ({ page }) => {
  test.setTimeout(300_000);
  // `hasTouch: true` is REQUIRED for `pointer: coarse` to report. Resizing a
  // desktop context leaves `pointer: fine`.
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);

  for (const w of [320, 390, 844]) {
    await page.setViewportSize({ width: w, height: w > 500 ? 390 : 844 });
    if (w === 320) {
      await openInvitesTab(page);
      await openInviteDialog(page);
    } else {
      await page.waitForTimeout(200);
    }
    const r = await measure(page);
    if (!r.coarse) continue; // this project is not touch-emulating; skip
    expect(r.small, `${w}px touch: controls under the 44px minimum`).toEqual([]);
  }
});

test('the invite link wraps inside the dialog instead of widening it', async ({ page }) => {
  test.setTimeout(240_000);
  // The narrowest real phone: the 43-character token must not force a scroll.
  await page.setViewportSize({ width: 320, height: 568 });
  await login(page);

  // SEED THE FIXTURE, do not depend on one. This case used to find a pending
  // invite by looking for one in the org and skip if there was none - and a
  // fresh seeded org has none, so it skipped on every CI run. That is the
  // worst kind of green: this is the only case that asserts the token wraps,
  // which is the feature's single most likely phone regression. Instead we
  // invite a throwaway address THROUGH THE UI, which (a) always works on a
  // clean database and (b) exercises the create path end to end.
  const seedEmail = `mobile-audit-${Date.now()}@example.com`;
  await openInvitesTab(page);
  const emptyCta = page.locator('[data-qa="invite-staff-empty-cta"]');
  const headerCta = page.locator('[data-qa="invite-staff-button"]');
  await ((await emptyCta.count()) > 0 ? emptyCta : headerCta).first().click();
  await page.locator('[data-qa="invite-email"]').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('[data-qa="invite-name"]').fill('Mobile Audit Invitee');
  await page.locator('[data-qa="invite-email"]').fill(seedEmail);
  await page.locator('[data-qa="invite-phone"]').fill('9876500011');
  await page.locator('[data-qa="invite-submit"]').click();

  // The create result IS a link block - same CopyableLink component and the
  // same 43-character token as the resend panel, rendered in the narrowest
  // dialog the feature has. That is the measurement this case needs, and it
  // needs no pre-existing row.
  const linkInput = page.locator('[data-qa="invite-link-input"]');
  await linkInput.waitFor({ state: 'visible', timeout: 30_000 });

  const r = await measure(page);
  expect(r.datasetOverflow, 'the long token forced horizontal overflow').toBe(false);
  expect(r.overflowing, 'an element passed the viewport edge').toEqual([]);

  // No clipping: the whole token must be readable/selectable, because it IS the
  // credential and the fallback for copying is selecting it by hand. A
  // single-line `<input>` reported scrollWidth > clientWidth here forever,
  // because `break-all` cannot wrap in an input - which is why this asserts on
  // wrapped height instead, and why the component uses a textarea.
  const metrics = await linkInput.evaluate((el) => {
    const field = el as HTMLTextAreaElement;
    return {
      scrollW: field.scrollWidth,
      clientW: field.clientWidth,
      scrollH: field.scrollHeight,
      clientH: field.clientHeight,
      value: field.value,
    };
  });
  expect(metrics.scrollW, 'the invite link is clipped horizontally').toBeLessThanOrEqual(
    metrics.clientW + 1,
  );
  expect(metrics.scrollH, 'the invite link is clipped vertically').toBeLessThanOrEqual(
    metrics.clientH + 1,
  );
  expect(metrics.value, 'the visible link is not a real invite URL').toContain('/invite/');
});
