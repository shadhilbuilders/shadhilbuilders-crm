// Where a notification row should take the reader (2026-11-10).
//
// Rows used to be dead text. A unit-anchored site notification links to the
// villa's site page - EXCEPT `progress.unassigned`: that villa is no longer the
// reader's, so its page would 404/403; the site home (their remaining villas) is
// the honest destination. Lead notifications link to the lead. Anything else
// has no destination and stays plain text rather than a dead link.
import { projectHref } from '@/lib/nav';

export interface NotificationLinkInput {
  readonly type?: string | null;
  readonly leadId?: string | null;
  readonly unitId?: string | null;
}

/** App route for a notification row, or null when it has no destination. */
export function notificationHref(
  orgSlug: string | null,
  projectSlug: string | null,
  row: NotificationLinkInput,
): string | null {
  if (orgSlug === null || projectSlug === null) return null;
  if (row.type === 'progress.unassigned') {
    return projectHref(orgSlug, projectSlug, '/site');
  }
  if (typeof row.unitId === 'string' && row.unitId.length > 0) {
    return projectHref(orgSlug, projectSlug, `/site/${row.unitId}`);
  }
  if (typeof row.leadId === 'string' && row.leadId.length > 0) {
    return projectHref(orgSlug, projectSlug, `/leads/${row.leadId}`);
  }
  return null;
}
