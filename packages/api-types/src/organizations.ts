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
