// Where a notification row should take the reader (2026-11-10).
//
// Rows used to be dead text. A unit-anchored site notification links to the
// villa's site page - EXCEPT `progress.unassigned`: that villa is no longer the
// reader's, so its page would 404/403; the site home (their remaining villas) is
// the honest destination. Lead notifications link to the lead. Anything else
// has no destination and stays plain text rather than a dead link.
//
// 2026-11-21 - ORGANIZATION-LEVEL DESTINATIONS. A notification does not always
// hang off a project. `feedback.created` is about the company, not a villa: the
// visitor wrote it on the landing page, and the thing the admin must act on is
// the triage inbox at `/{orgSlug}/admin/feedback`. That page is org-scoped, so
// it needs `orgSlug` but NOT `projectSlug` - which is why the org-level branch
// runs BEFORE the project-slug guard below.
//
// Kept in lockstep with ORG_LEVEL_NOTIFICATION_TYPES in the backend's
// notifications.service.ts: the backend exempts exactly these types from the
// active-project filter, and this file routes them to an org-scoped page. If
// the two disagreed, a row would either be invisible or a dead link.
import { isOrgLevelNotificationType } from '@shadhil/api-types';

import { orgHref, projectHref } from '@/lib/nav';

/** Org-scoped destination per org-level type. */
const ORG_LEVEL_HREF: Record<string, string> = {
  'feedback.created': '/admin/feedback',
};

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
  if (orgSlug === null) return null;

  // Org-level events win: they are reachable from anywhere in the org, and the
  // project slug is irrelevant (and often simply absent - the reader may be on
  // an admin page, which has no project in context).
  if (isOrgLevelNotificationType(row.type)) {
    const template = ORG_LEVEL_HREF[row.type as string];
    return template !== undefined ? orgHref(orgSlug, template) : null;
  }

  if (projectSlug === null) return null;
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
