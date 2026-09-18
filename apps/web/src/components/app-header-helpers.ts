// app-header helpers - PURE, so the hydration-sensitive decisions unit-test
// without rendering the header (which pulls in the whole app shell).
//
// WHY THIS EXISTS (hydration regression, 2026-09-18):
// `NotificationBell` gated `href` behind a `mounted` flag but rendered `unread`
// unguarded. `unread` comes from a client-only query, so the SERVER rendered 0
// ("Notifications") while the first CLIENT paint rendered the real count
// ("38 unread notifications"). React reported:
//
//   Hydration failed because the server rendered HTML didn't match the client.
//
// and regenerated the whole tree. The bug was easy to miss because the `href`
// gate right next to it was correct - one value was gated, its sibling wasn't.
//
// The rule these helpers encode: EVERY value that depends on client-only state
// AND lands in markup (text or attribute) must be gated behind `mounted`, so the
// server and first client paint agree.

/**
 * The unread count to RENDER. Returns 0 until mounted.
 *
 * Returns a number, always - so callers can't accidentally interpolate
 * `undefined` into markup.
 */
export function renderedUnreadCount(
  mounted: boolean,
  unreadFromQuery: number | null | undefined,
): number {
  if (!mounted) return 0;
  return unreadFromQuery ?? 0;
}

/**
 * Accessible label for the notification bell.
 *
 * Depends on the SAME gated count as the visual badge - if these two used
 * different sources, aria-label and the badge could disagree, which is both a
 * hydration risk and an a11y bug.
 */
export function notificationBellLabel(renderedUnread: number): string {
  return renderedUnread > 0 ? `${renderedUnread} unread notifications` : 'Notifications';
}
