// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Dashboard stats DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// GET /api/dashboard/stats - one aggregate endpoint returning all KPI + chart
// data for the project work dashboard. Role-scoped server-side (mirrors
// leads/visits): TELECALLER/SALES_EXEC see own leads, MANAGER sees team,
// ADMIN/OWNER see all. `projectId` is OPTIONAL so the same endpoint can serve
// the cross-project /overview command center later (T-OVERVIEW-STATS) without
// a re-architecture.
//
// Data-confidence honesty (autoplan 2026-09-08, CEO F3): metrics that depend
// on data the team may not produce yet (avgTimeToFirstTouch from Activity,
// noShowRate from visit outcomes) return null/0 HONESTLY - never a fabricated
// number. The UI renders "-"/0 and the sub-label explains "no outcome data yet".
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * GET /api/dashboard/stats query. `projectId` is a real cuid2
 * (T-PROJID-CUID2, 2026-09-08) - the same format the [projectId] URL segment
 * and every other filter pin to. Optional: omit for cross-project stats.
 */
export const DashboardStatsQuerySchema = z.object({
  projectId: z.cuid2().optional(),
});
export type DashboardStatsQuery = z.infer<typeof DashboardStatsQuerySchema>;

/** A single pipeline bucket: lead status + count. */
export const PipelineBucketSchema = z.object({
  status: z.string(),
  count: z.number().int().min(0),
});
export type PipelineBucket = z.infer<typeof PipelineBucketSchema>;

/** A single leads-over-time bucket: ISO date + count. */
export const LeadsOverTimeBucketSchema = z.object({
  date: z.string(),
  count: z.number().int().min(0),
});
export type LeadsOverTimeBucket = z.infer<typeof LeadsOverTimeBucketSchema>;

/** A single lead-source bucket: source + count. */
export const LeadSourceBucketSchema = z.object({
  source: z.string(),
  count: z.number().int().min(0),
});
export type LeadSourceBucket = z.infer<typeof LeadSourceBucketSchema>;

/** A single team-performance bucket: owner + count. */
export const TeamPerformanceBucketSchema = z.object({
  ownerId: z.string(),
  ownerName: z.string(),
  count: z.number().int().min(0),
});
export type TeamPerformanceBucket = z.infer<typeof TeamPerformanceBucketSchema>;

/** A single visits-this-week bucket: weekday label + count. */
export const VisitsThisWeekBucketSchema = z.object({
  day: z.string(),
  count: z.number().int().min(0),
});
export type VisitsThisWeekBucket = z.infer<typeof VisitsThisWeekBucketSchema>;

/** A single bookings-by-status bucket: status + count. */
export const BookingsByStatusBucketSchema = z.object({
  status: z.string(),
  count: z.number().int().min(0),
});
export type BookingsByStatusBucket = z.infer<typeof BookingsByStatusBucketSchema>;

/**
 * Full dashboard stats payload. Every field is a real aggregate - no fake
 * data. Metrics with no underlying rows return 0 (counts) or null
 * (avgTimeToFirstTouch) so the UI can render the honest empty state.
 */
export const DashboardStatsSchema = z.object({
  kpis: z.object({
    newLeadsToday: z.number().int().min(0),
    overdueLeads: z.number().int().min(0),
    visitsToday: z.number().int().min(0),
    visitsThisWeek: z.number().int().min(0),
    bookingsOnHold: z.number().int().min(0),
    // % of visits in the last 7 days that were NO_SHOW. 0 when no outcome
    // data exists (honest "no signal", not "0% no-show").
    noShowRate: z.number().min(0).max(100),
    // Minutes from Lead.createdAt to first Activity (STATUS_CHANGE/CALL).
    // null when no activity rows exist in scope.
    avgTimeToFirstTouch: z.number().min(0).nullable(),
  }),
  pipeline: z.array(PipelineBucketSchema),
  leadsOverTime: z.array(LeadsOverTimeBucketSchema),
  leadSources: z.array(LeadSourceBucketSchema),
  teamPerformance: z.array(TeamPerformanceBucketSchema),
  visitsThisWeek: z.array(VisitsThisWeekBucketSchema),
  bookingsByStatus: z.array(BookingsByStatusBucketSchema),
});
export type DashboardStats = z.infer<typeof DashboardStatsSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Cross-project overview (T-OVERVIEW-STATS, autoplan 2026-09-08)
// ────────────────────────────────────────────────────────────────────────────
// GET /api/dashboard/overview - the admin/owner command center. Cross-project
// (no projectId filter), ADMIN/OWNER only (service guard). Returns the KPIs
// and charts the /overview page needs in one role-scoped query.
// ────────────────────────────────────────────────────────────────────────────

/** A single users-by-role bucket: role + count. */
export const UsersByRoleBucketSchema = z.object({
  role: z.string(),
  count: z.number().int().min(0),
});
export type UsersByRoleBucket = z.infer<typeof UsersByRoleBucketSchema>;

/** A single audit-timeline bucket: ISO date + count. */
export const AuditTimelineBucketSchema = z.object({
  date: z.string(),
  count: z.number().int().min(0),
});
export type AuditTimelineBucket = z.infer<typeof AuditTimelineBucketSchema>;

/**
 * Full cross-project overview payload. Every field is a real aggregate - no
 * fake data. Metrics with no underlying rows return 0 (counts) so the UI can
 * render the honest empty state.
 */
export const DashboardOverviewStatsSchema = z.object({
  kpis: z.object({
    totalLeads: z.number().int().min(0),
    reassignments7d: z.number().int().min(0),
    auditEvents24h: z.number().int().min(0),
    usersByRole: z.array(UsersByRoleBucketSchema),
  }),
  pipeline: z.array(PipelineBucketSchema),
  visitsThisWeek: z.array(VisitsThisWeekBucketSchema),
  auditTimeline: z.array(AuditTimelineBucketSchema),
});
export type DashboardOverviewStats = z.infer<typeof DashboardOverviewStatsSchema>;
