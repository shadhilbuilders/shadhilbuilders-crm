// Regression tests for the header hydration contract.
//
// The bug these pin: `NotificationBell` rendered a client-only unread count on
// the server, so SSR said "Notifications" and the client said
// "38 unread notifications" -> React "Hydration failed because the server
// rendered HTML didn't match the client" and regenerated the tree.
//
// The invariant is that EVERY client-only value reaching markup is gated behind
// `mounted`. These helpers make that testable without rendering the header.
import { describe, expect, it } from 'vitest';

import { notificationBellLabel, renderedUnreadCount } from './app-header-helpers';

describe('renderedUnreadCount - the hydration gate', () => {
  it('returns 0 before mount, whatever the query says', () => {
    // This is the fix: the server (and the first client paint) must agree, so
    // the pre-mount render can never show a live count.
    expect(renderedUnreadCount(false, 38)).toBe(0);
    expect(renderedUnreadCount(false, 1)).toBe(0);
    expect(renderedUnreadCount(false, 0)).toBe(0);
    expect(renderedUnreadCount(false, null)).toBe(0);
    expect(renderedUnreadCount(false, undefined)).toBe(0);
  });

  it('returns the real count after mount', () => {
    expect(renderedUnreadCount(true, 38)).toBe(38);
    expect(renderedUnreadCount(true, 1)).toBe(1);
    expect(renderedUnreadCount(true, 0)).toBe(0);
  });

  it('degrades a missing count to 0 (never undefined in markup)', () => {
    expect(renderedUnreadCount(true, null)).toBe(0);
    expect(renderedUnreadCount(true, undefined)).toBe(0);
  });

  it('returns a number in every branch, so markup never renders "undefined"', () => {
    for (const mounted of [true, false]) {
      for (const value of [undefined, null, 0, 7]) {
        expect(typeof renderedUnreadCount(mounted, value)).toBe('number');
      }
    }
  });
});

describe('notificationBellLabel', () => {
  it('labels by count', () => {
    expect(notificationBellLabel(0)).toBe('Notifications');
    expect(notificationBellLabel(1)).toBe('1 unread notifications');
    expect(notificationBellLabel(38)).toBe('38 unread notifications');
  });

  it('is the SAME source as the badge (pre-mount label is the zero-state one)', () => {
    // Label and badge must derive from one gated value, or aria-label and the
    // visible badge can disagree - a hydration risk AND an a11y bug.
    const preMount = renderedUnreadCount(false, 38);
    expect(notificationBellLabel(preMount)).toBe('Notifications');

    const postMount = renderedUnreadCount(true, 38);
    expect(notificationBellLabel(postMount)).toBe('38 unread notifications');
  });
});
