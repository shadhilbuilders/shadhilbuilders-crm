// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Organization DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// The Organization is the multi-tenant axis (see schema.prisma `Organization`
// model). These shapes back the slug-based URL routing:
//   GET /organizations/by-slug/:slug -> Organization (server layout resolves
//                                       the [orgSlug] segment to the org; the
//                                       page then uses org.id for id-keyed
//                                       APIs/hooks).
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * Shape returned by GET /organizations/by-slug/:slug. Slug is the public
 * URL identity; `id` is the internal tenant key carried on every row via
 * `organizationId` (and threaded to the client via context so pages keep
 * using id-keyed hooks/APIs unchanged).
 */
export const OrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

// ── Organization settings (T-VISIT-REMINDER, 2026-10-09) ─────────────────────
/** Bounds for how long before a visit the reminder fires. Mirrors the DB CHECK. */
export const VISIT_REMINDER_MIN_MINUTES = 5;
export const VISIT_REMINDER_MAX_MINUTES = 1440;

export const OrganizationSettingsSchema = z.object({
  visitReminderLeadMinutes: z
    .number()
    .int()
    .min(VISIT_REMINDER_MIN_MINUTES)
    .max(VISIT_REMINDER_MAX_MINUTES),
});
export type OrganizationSettings = z.infer<typeof OrganizationSettingsSchema>;

/** PATCH body: every field optional, at least one required. */
export const UpdateOrganizationSettingsSchema = OrganizationSettingsSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'Provide at least one setting to change' },
);
export type UpdateOrganizationSettings = z.infer<typeof UpdateOrganizationSettingsSchema>;
