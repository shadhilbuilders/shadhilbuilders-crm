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
  notificationIds: z.array(z.string().cuid()).default([]),
});
export type MarkReadDto = z.infer<typeof MarkReadDtoSchema>;

/**
 * GET /api/notifications query filter.
 */
export const NotificationFilterDtoSchema = z.object({
  unreadOnly: z.boolean().default(false),
  type: z.string().optional(),
  // Seed project ids are readable (`seed-project-metro-heights`), not
  // cuids - same convention as leads.ts projectId. Resolved through
  // Notification.lead.projectId on the server.
  projectId: z.string().trim().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type NotificationFilterDto = z.infer<typeof NotificationFilterDtoSchema>;

/**
 * SSE event shape for the notifications channel.
 */
export const NotificationEventSchema = z.object({
  id: z.string().cuid(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  leadId: z.string().cuid().nullable().optional(),
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
