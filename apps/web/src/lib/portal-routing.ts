// Where each role belongs (issue #8 slice 2, spec D6/D7), plus the first-login
// password gate (spec D3).
//
// CUSTOMER lives ONLY under /portal; every staff role lives ONLY under
// /{orgSlug}. There is no staff preview of the portal (D7). This is a
// courtesy that keeps people off the wrong shell - RLS and the API's 403s are
// the real wall, never this file.
//
// Two entry points, one question each:
//   - `redirectForArea`  - the STAFF shell's guard (area only; staff are never
//                          password-gated, so it has nothing to say about D3).
//   - `portalGateFor`    - the PORTAL's guard (area AND the password gate).
//
// The portal answers both in one function deliberately (2026-11-10): they run
// in the same effect in the portal layout, and two independent effects racing
// each other (one pushing /portal, the other /portal/change-password) is
// exactly how a gated buyer ends up flashing the portal before the bounce.
// A function that returns "the one place this session may be" cannot disagree
// with itself.
import type { Role } from '@/apis/client';

export const PORTAL_HOME = '/portal';

/**
 * The forced rotation screen (issue #8 slice 2, D3). Lives INSIDE the portal
 * shell - a buyer keeps the masthead (and therefore Sign out) while rotating,
 * and never sees the guest card's "Cancel", which used to route to `/` and
 * strand a gated buyer in a bounce loop.
 */
export const PORTAL_CHANGE_PASSWORD = '/portal/change-password';

export type RouteArea = 'staff' | 'portal';

export type PortalGateInput = {
  /** `undefined` means "no session" - the layout passes `user?.role`. */
  role: Role | undefined;
  /** Session snapshot; false when the payload omits the field (fail-open). */
  mustChangePassword: boolean;
  /** Current pathname, so the gate can tell "needs rotating" from "already there". */
  pathname: string;
  /**
   * Current `location.search`, including the leading `?` (2026-11-25).
   *
   * This exists because the WhatsApp button deep-links to
   * `/portal?unit=<id>&photo=<rowId>` and the portal opens that photo full-bleed.
   * The gate used to send a signed-out buyer to a hardcoded `/login?next=/portal`,
   * which dropped the query, so after signing in they arrived at a bare portal and
   * the photo they were told about never opened - the one thing the message was for.
   * Omitted means "no query", which keeps the old behaviour exact.
   */
  search?: string;
};

/**
 * Where a signed-out buyer should be sent so that signing in lands them back on
 * the exact URL they tapped, query included.
 *
 * Only paths under the portal are remembered: this value ends up in a URL, and a
 * caller that passed something else would be handing out a redirect target we did
 * not choose. The login form validates `next` again (absolute path on this origin),
 * so this is the second of two checks, not the only one.
 */
function portalLoginNext(pathname: string, search: string | undefined): string {
  const path = pathname.startsWith('/portal') ? pathname : PORTAL_HOME;
  // No query keeps the plain form (`/login?next=/portal`), which is both the
  // historical shape and easier to read in a log. With a query it MUST be
  // encoded, or `&` would split it into parameters the login form never reads.
  if (search === undefined || !search.startsWith('?') || search.length < 2) {
    return `/login?next=${path}`;
  }
  return `/login?next=${encodeURIComponent(`${path}${search}`)}`;
}

/**
 * The path this session must be at, or null when it may stay where it is.
 *
 * Precedence: session -> area -> password. The password gate is checked AFTER
 * the role bounce, so a staff user holding an armed flag is still sent out of
 * the portal rather than into a customer rotation screen.
 */
export function portalGateFor({
  role,
  mustChangePassword,
  pathname,
  search,
}: PortalGateInput): string | null {
  // 1. No session -> sign in, remembering THIS page (query included) as the
  //    destination, so a WhatsApp photo link survives the login wall.
  if (role === undefined) return portalLoginNext(pathname, search);

  // 2. Only a CUSTOMER may be in the portal at all (no staff preview, D7).
  if (role !== 'CUSTOMER') return '/';

  // 3. First-login rotation. `mustChangePassword` is true only for a buyer
  //    still holding the temporary password staff read out over WhatsApp.
  const onRotationRoute = pathname === PORTAL_CHANGE_PASSWORD;
  if (mustChangePassword) return onRotationRoute ? null : PORTAL_CHANGE_PASSWORD;

  // 4. Already rotated: the rotation screen is a dead end from here on. Sent
  //    home rather than left there so a stale tab cannot re-enter the flow.
  return onRotationRoute ? PORTAL_HOME : null;
}

/** Root `/`: buyers go to the portal, everyone else resolves their org. */
export function isPortalRole(role: Role | undefined): boolean {
  return role === 'CUSTOMER';
}

/**
 * The STAFF shell's guard: the path a user must be sent to, or null when they
 * are already in the right place. `role === undefined` means "no session".
 *
 * Staff are never first-login gated (only a CUSTOMER is armed, see
 * UsersService.create), so this stays a pure area check. The portal's
 * equivalent - which ALSO enforces the password rotation - is `portalGateFor`.
 */
export function redirectForArea(area: RouteArea, role: Role | undefined): string | null {
  if (role === undefined) return area === 'portal' ? `/login?next=${PORTAL_HOME}` : '/login';
  if (area === 'staff') return role === 'CUSTOMER' ? PORTAL_HOME : null;
  return role === 'CUSTOMER' ? null : '/';
}
