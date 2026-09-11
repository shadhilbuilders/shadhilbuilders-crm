// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Reminders module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// The cron processor (eng review A3) is Redis-locked: only one NestJS replica
// processes the per-minute tick. Reminders are SCHEDULED rows picked up by
// the cron job, then transitioned to SENT/FAILED/CANCELLED.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { ReminderTypeSchema, ReminderStatusSchema } from './enums';

/**
 * POST /api/reminders - schedule a new reminder.
 * Most reminders are created automatically by the Lead/Visit/Booking
 * services; this endpoint exists for manual override.
 */
export const CreateReminderDtoSchema = z.object({
  leadId: z.string().cuid2(),
  userId: z.string().cuid2(),
  type: ReminderTypeSchema,
  scheduledFor: z
    .string()
    .datetime({ offset: true })
    .refine((iso: string) => new Date(iso).getTime() > Date.now(), {
      message: 'scheduledFor must be in the future',
    }),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateReminderDto = z.infer<typeof CreateReminderDtoSchema>;

/**
 * PATCH /api/reminders/:id/cancel - cancel a scheduled reminder.
 * Used when the underlying entity changes (visit rescheduled, lead reassigned).
 */
export const CancelReminderDtoSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type CancelReminderDto = z.infer<typeof CancelReminderDtoSchema>;

/**
 * GET /api/reminders query filter.
 */
export const ReminderFilterDtoSchema = z.object({
  userId: z.string().cuid2().optional(),
  leadId: z.string().cuid2().optional(),
  type: z.union([ReminderTypeSchema, z.array(ReminderTypeSchema)]).optional(),
  status: z
    .union([ReminderStatusSchema, z.array(ReminderStatusSchema)])
    .optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ReminderFilterDto = z.infer<typeof ReminderFilterDtoSchema>;
