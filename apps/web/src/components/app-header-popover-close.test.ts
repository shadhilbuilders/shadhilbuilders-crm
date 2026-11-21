// Guard: every AppHeader popover closes itself on selection.
//
// WHY A SOURCE-LEVEL TEST. The popups are portalled to the document body, so
// they live OUTSIDE the route subtree. AppHeader is rendered by
// app/[orgSlug]/layout.tsx, which SURVIVES a route change - so an uncontrolled
// popover is never unmounted by navigation and stays open on top of the NEXT
// page until the user dismisses it. That is a property of how each `PopoverRoot`
// is wired and of its row handlers, not of anything jsdom can observe: rendering
// AppHeader takes the session, tenant context and four query hooks, and
// app-header-safe-area.test.ts pins its sibling contract the same way.
//
// THE CONTRACT:
//
//   1. every `PopoverRoot` here is CONTROLLED (`open` + `onOpenChange`) - an
//      uncontrolled root cannot be closed from a row handler at all;
//   2. the account menu's every actionable row closes it before acting: the
//      three links, and Sign out (which redirects, so the popup would otherwise
//      outlive the page);
//   3. the notification bell's "View all notifications" link closes it too -
//      that popover lives in the same layout and leaked the same way.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/components/app-header.tsx', 'utf8');

/** Source slice from a `data-qa` marker to the end of its opening tag. */
const openingTagFrom = (qa: string): string => {
  const start = source.indexOf(`data-qa="${qa}"`);
  expect(start, `row ${qa} is missing`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('>', start);
  return source.slice(start, end);
};

describe('AppHeader popovers close on selection', () => {
  it('every PopoverRoot is controlled, so handlers can close it', () => {
    const roots = source.match(/<PopoverRoot[^>]*>/g) ?? [];
    // Two popovers ship today: the notification bell and the account menu.
    // A new one is welcome - it just has to be controlled too.
    expect(roots.length).toBeGreaterThanOrEqual(2);
    for (const root of roots) {
      expect(root, `${root} is uncontrolled and can never be closed on select`).toContain(
        'open={open}',
      );
      expect(root, `${root} cannot be closed on select`).toContain('onOpenChange={setOpen}');
    }
  });

  it('the account menu closes on every navigating row', () => {
    expect(source).toContain('const closeMenu = () => setOpen(false);');
    for (const qa of ['account-menu-admin', 'account-menu-employee', 'account-menu-settings']) {
      expect(openingTagFrom(qa), `${qa} does not close the menu`).toContain('onClick={closeMenu}');
    }
  });

  it('Sign out closes the account menu before redirecting', () => {
    const start = source.indexOf('<LuLogOut');
    expect(start).toBeGreaterThanOrEqual(0);
    // The Button's handler sits in the ~600 chars before its icon.
    const signOutButton = source.slice(Math.max(0, start - 600), start);
    const closeAt = signOutButton.indexOf('closeMenu();');
    const signOutAt = signOutButton.indexOf('onSignOut();');
    expect(closeAt, 'Sign out never closes the menu').toBeGreaterThanOrEqual(0);
    expect(signOutAt, 'Sign out lost its handler').toBeGreaterThan(closeAt);
  });

  it('the notification bell closes before navigating to the inbox', () => {
    // The footer link is the only navigation inside that popover. Anchor on the
    // rendered label, not the bare phrase (a comment above also says it).
    const start = source.lastIndexOf('View all notifications');
    expect(start).toBeGreaterThanOrEqual(0);
    const link = source.slice(Math.max(0, start - 400), start);
    expect(link, 'the inbox link leaves the bell popover open').toContain(
      'onClick={() => setOpen(false)}',
    );
  });

  it('the notification bell closes when a ROW navigates', () => {
    // 2026-11-21: rows became clickable (feedback -> the admin triage page,
    // leads -> the lead). Same layout-leak as the footer link: without the close
    // the popover survives the navigation and covers the destination.
    const start = source.indexOf('data-qa="notification-popover-link"');
    expect(start, 'the popover row lost its link').toBeGreaterThanOrEqual(0);
    const handler = source.slice(start, start + 500);
    expect(handler, 'a navigating row leaves the bell popover open').toContain('setOpen(false)');
  });

  it('every popover row resolves its destination through notificationHref', () => {
    // The rows must not hand-roll URLs: an org-level event (feedback) has no
    // project anchor, and only notificationHref knows that.
    expect(source).toContain("from '@/lib/notification-links'");
    expect(source).toContain('notificationHref(orgSlug, projectSlugCtx, row)');
  });
});
