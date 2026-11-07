// Where each role belongs (issue #8 slice 2, spec D6/D7).
//
// CUSTOMER lives ONLY under /portal; every staff role lives ONLY under
// /{orgSlug}. There is no staff preview of the portal (D7). This is a
// courtesy that keeps people off the wrong shell - RLS and the API's 403s are
// the real wall, never this file.
import type { Role } from '@/apis/client';

export const PORTAL_HOME = '/portal';

export type RouteArea = 'staff' | 'portal';

/**
 * The path a user must be sent to, or null when they are already in the
 * right place. `role === undefined` means "no session".
 */
export function redirectForArea(area: RouteArea, role: Role | undefined): string | null {
  if (role === undefined) return area === 'portal' ? `/login?next=${PORTAL_HOME}` : '/login';
  if (area === 'staff') return role === 'CUSTOMER' ? PORTAL_HOME : null;
  return role === 'CUSTOMER' ? null : '/';
}

/** Root `/`: buyers go to the portal, everyone else resolves their org. */
export function isPortalRole(role: Role | undefined): boolean {
  return role === 'CUSTOMER';
}
