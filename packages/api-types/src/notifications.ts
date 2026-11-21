// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Notifications module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// The in-app inbox uses the Notification model directly (no separate
// InAppNotification - eng review C2). SSE channel: user:<id>:notifications.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * PATCH /api/notifications/mark-read - mark a batch as read.
 * Empty array = mark all as read.
 */
export const MarkReadDtoSchema = z.object({
  notificationIds: z.array(z.string().cuid2()).default([]),
});
export type MarkReadDto = z.infer<typeof MarkReadDtoSchema>;

/**
 * GET /api/notifications query filter.
 */
export const NotificationFilterDtoSchema = z.object({
  unreadOnly: z.boolean().default(false),
  type: z.string().optional(),
  // Filter by notification-type prefix (e.g. 'lead' matches lead.created,
  // lead.transition, lead.reassigned). Enables the Leads/Bookings/Visits
  // filter tabs, which each span multiple concrete types.
  typePrefix: z.string().optional(),
  // Project.id is a plain string (cuid() default, but seed data uses
  // slug-like ids). Accept any non-empty string - NOT z.cuid2().
  projectId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type NotificationFilterDto = z.infer<typeof NotificationFilterDtoSchema>;

/**
 * Notification types that belong to the ORGANIZATION, not to a project
 * (2026-11-21).
 *
 * THE CONTRACT THIS ENCODES. The notifications page always sends the active
 * project id, and the backend narrows the inbox to that project's lead and unit
 * ids. A notification with neither anchor would be inserted and then
 * permanently invisible - the bug the `unitId` arm was added to fix for site
 * photos. Org-level events are the deliberate exception: they are exempt from
 * that narrowing, and the web links them to an org-scoped page.
 *
 * ONE list, consumed by BOTH sides, because the failure mode of drift is silent:
 * the backend would hide the row or the web would render a dead link, and
 * neither shows up as an error. Add a type here when a new org-level event
 * ships, never one side at a time.
 *
 * `feedback.created`: a public feedback submission. `progress.*` types are
 * project-scoped (site staff only) and must NOT be added here.
 */
export const ORG_LEVEL_NOTIFICATION_TYPES = ['feedback.created'] as const;

export type OrgLevelNotificationType = (typeof ORG_LEVEL_NOTIFICATION_TYPES)[number];

/**
 * Notification types that ONLY the admin class may be served (2026-11-21).
 *
 * WHY THIS IS A SEPARATE LIST FROM "org-level". The two axes are different
 * questions and conflating them is a real leak:
 *
 *   - ORG-LEVEL means "not attached to a project", so the active-project filter
 *     must not hide it. `feedback.created` is org-level.
 *   - ADMIN-ONLY means "only ADMIN/OWNER may see it at all". `feedback.created`
 *     is also admin-only, because its only destination
 *     (`/{orgSlug}/admin/feedback`) 403s for every other role.
 *
 * Resolving the audience at EMIT time (live ADMIN/OWNER rows) is necessary but
 * NOT sufficient: a Notification row is keyed by `userId` and outlives the role
 * that earned it. Demote an ADMIN to TELECALLER and their existing
 * `feedback.created` rows are still theirs - so the list, the unread badge and
 * the SSE stream would keep serving rows that link to a page they cannot open.
 * The role gate therefore has to be applied on every READ path as well, which is
 * what this list is for.
 */
export const ADMIN_ONLY_NOTIFICATION_TYPES = ['feedback.created'] as const;

export type AdminOnlyNotificationType = (typeof ADMIN_ONLY_NOTIFICATION_TYPES)[number];

/** ADMIN or OWNER - the roles the admin namespace (and its pages) admit. */
function isAdminClassRole(role: string | null | undefined): boolean {
  return role === 'ADMIN' || role === 'OWNER';
}

/**
 * Types the viewer's role must never be served.
 *
 * `null` = no restriction (admin class). An ARRAY, possibly empty in principle,
 * is a real restriction - callers must express it as `type: { notIn: [...] }`,
 * never treat it as "no filter". Used by all three read paths: the REST list,
 * the unread badge count, and the SSE stream fetcher. One helper so they can
 * never disagree about who sees what.
 */
export function notificationTypesHiddenFrom(role: string | null | undefined): string[] | null {
  return isAdminClassRole(role) ? null : [...ADMIN_ONLY_NOTIFICATION_TYPES];
}

/** True when `type` is an org-level notification (no project anchor needed). */
export function isOrgLevelNotificationType(type: string | null | undefined): boolean {
  return (
    typeof type === 'string' && (ORG_LEVEL_NOTIFICATION_TYPES as readonly string[]).includes(type)
  );
}

/**
 * SSE event shape for the notifications channel.
 */
export const NotificationEventSchema = z.object({
  id: z.string().cuid2(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  leadId: z.string().cuid2().nullable().optional(),
  /** Site-update notifications anchor to a unit, not a lead (2026-11-08). */
  unitId: z.string().nullable().optional(),
  read: z.boolean().default(false),
  createdAt: z.string().datetime({ offset: true }),
});
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;

/**
 * POST /api/push/subscribe - register a push subscription.
 * WEB uses VAPID, IOS/Android route through Expo Push.
 */
export const RegisterPushDtoSchema = z.object({
  endpoint: z.string().url(),
  p256dh: z.string().min(1),
  auth: z.string().min(1),
  platform: z.enum(['WEB', 'IOS', 'ANDROID']),
});
export type RegisterPushDto = z.infer<typeof RegisterPushDtoSchema>;
