// Dashboard service - one aggregate endpoint for the project work dashboard.
//
// GET /api/dashboard/stats?projectId=<cuid2> returns all KPI + chart data in a
// single role-scoped query. Mirrors the leads/visits scoping exactly:
//   - TELECALLER/SALES_EXEC: leads where Lead.ownerId === actor.sub
//   - MANAGER: leads where Lead.teamId matches the team they manage
//     (Team.managerId === actor.sub lookup, same as leads.service.managerTeamId)
//   - ADMIN/OWNER: all leads (RLS policies enforce cross-tenant boundaries)
//
// `projectId` is OPTIONAL (z.cuid2().optional()) so the same endpoint can serve
// the cross-project /overview command center later (T-OVERVIEW-STATS) without
// a re-architecture.
//
// Data-confidence honesty (autoplan 2026-09-08, CEO F3): metrics that depend on
// data the team may not produce yet return null/0 HONESTLY - never a fabricated
// number. avgTimeToFirstTouch is null when no Activity rows exist; noShowRate is
// 0 when no visit outcomes are logged (documented as "no outcome data yet").
//
// Every query runs inside ONE withRlsContext so the RLS session vars are set
// once and all aggregates see the same role-scoped view (AGENTS.md mandatory).
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Prisma, withRlsContext, type PrismaClient, type Role } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type {
  DashboardOverviewStats,
  DashboardStats,
  DashboardStatsQuery,
} from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';

/** Monday-start week containing `now` (matches VisitsThisWeekChart). */
function startOfWeek(now: Date): Date {
  const copy = new Date(now);
  const day = copy.getDay(); // 0 = Sunday
  const diff = (day + 6) % 7; // shift so Monday = 0
  copy.setDate(copy.getDate() - diff);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** ISO day key (yyyy-mm-dd) for a Date. */
function isoDay(d: Date): string {
  return d.toLocaleDateString('en-CA');
}

/** Zero-fill an array of {key, count} buckets across a date range. */
function zeroFillDateRange(
  buckets: Array<{ key: string; count: number }>,
  start: Date,
  days: number,
): Array<{ date: string; count: number }> {
  const counts: Record<string, number> = {};
  for (const b of buckets) counts[b.key] = b.count;
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = isoDay(d);
    return { date: key, count: counts[key] ?? 0 };
  });
}

@Injectable()
export class DashboardService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * Resolve the team a MANAGER leads (mirrors leads.service.managerTeamId).
   * Returns null for ADMIN (no team) or a MANAGER with no team.
   */
  private async managerTeamId(
    tx: PrismaClient,
    actor: JwtPayload,
  ): Promise<string | null> {
    if (actor.role === 'MANAGER') {
      const team = await tx.team.findFirst({
        where: { managerId: actor.sub },
        select: { id: true },
      });
      return team?.id ?? null;
    }
    if (actor.role === 'ADMIN' || actor.role === 'OWNER') {
      return actor.teamId;
    }
    return null;
  }

  /**
   * Build the role-scoped `where` for leads. Mirrors leads.service.listWhere:
   * staff narrowed to own/team, admin/owner unrestricted (RLS is the wall).
   */
  private async leadWhere(
    tx: PrismaClient,
    actor: JwtPayload,
    projectId: string | undefined,
  ): Promise<Record<string, unknown>> {
    const where: Record<string, unknown> = {};
    if (projectId !== undefined) where['projectId'] = projectId;
    if (actor.role === 'TELECALLER' || actor.role === 'SALES_EXEC') {
      where['ownerId'] = actor.sub;
    } else if (actor.role === 'MANAGER') {
      const teamId = await this.managerTeamId(tx, actor);
      where['teamId'] = teamId ?? '__no_team__';
    }
    return where;
  }

  /**
   * GET /api/dashboard/stats - all KPI + chart aggregates in one role-scoped
   * query. Returns the full DashboardStats payload.
   */
  async getStats(
    actor: JwtPayload,
    query: DashboardStatsQuery,
  ): Promise<DashboardStats> {
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const txClient = tx as unknown as PrismaClient;
        const leadWhere = await this.leadWhere(txClient, actor, query.projectId);

        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);
        const weekStart = startOfWeek(now);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);
        const fourteenDaysAgo = new Date(now);
        fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 13);
        fourteenDaysAgo.setHours(0, 0, 0, 0);
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
        sevenDaysAgo.setHours(0, 0, 0, 0);

        // Visit where: role-scoped via parent Lead (SiteVisit has no projectId).
        const visitWhere: Record<string, unknown> = {};
        if (query.projectId !== undefined) {
          visitWhere['lead'] = { projectId: query.projectId };
        }
        if (actor.role === 'TELECALLER' || actor.role === 'SALES_EXEC') {
          visitWhere['lead'] = { ownerId: actor.sub };
        } else if (actor.role === 'MANAGER') {
          const teamId = await this.managerTeamId(txClient, actor);
          visitWhere['lead'] = { teamId: teamId ?? '__no_team__' };
        }

        // Booking where: role-scoped via parent Lead (Booking has no projectId).
        const bookingWhere: Record<string, unknown> = {};
        if (query.projectId !== undefined) {
          bookingWhere['lead'] = { projectId: query.projectId };
        }
        if (actor.role === 'TELECALLER' || actor.role === 'SALES_EXEC') {
          bookingWhere['lead'] = { ownerId: actor.sub };
        } else if (actor.role === 'MANAGER') {
          const teamId = await this.managerTeamId(txClient, actor);
          bookingWhere['lead'] = { teamId: teamId ?? '__no_team__' };
        }

        // Run all aggregates in parallel (single round-trip, no N+1).
        const [
          newLeadsToday,
          overdueLeads,
          pipeline,
          leadSources,
          leadsOverTime,
          teamPerformance,
          visitsToday,
          visitsThisWeekBuckets,
          visitsLast7d,
          bookingsOnHold,
          bookingsByStatus,
          avgTimeToFirstTouch,
        ] = await Promise.all([
          // newLeadsToday: leads created today in scope.
          txClient.lead.count({
            where: { ...leadWhere, createdAt: { gte: todayStart } },
          }),
          // overdueLeads: NEW + created > 30 min ago (mirrors leads.service).
          txClient.lead.count({
            where: {
              ...leadWhere,
              state: 'NEW',
              createdAt: { lte: new Date(now.getTime() - 30 * 60 * 1000) },
            },
          }),
          // pipeline: leads by status.
          txClient.lead.groupBy({
            by: ['state'],
            where: leadWhere,
            _count: { _all: true },
          }),
          // leadSources: leads by source.
          txClient.lead.groupBy({
            by: ['source'],
            where: leadWhere,
            _count: { _all: true },
          }),
          // leadsOverTime: leads by createdAt day, last 14 days.
          txClient.lead.groupBy({
            by: ['createdAt'],
            where: { ...leadWhere, createdAt: { gte: fourteenDaysAgo } },
            _count: { _all: true },
          }),
          // teamPerformance: leads by ownerId.
          txClient.lead.groupBy({
            by: ['ownerId'],
            where: leadWhere,
            _count: { _all: true },
          }),
          // visitsToday: visits scheduled today in scope.
          txClient.siteVisit.count({
            where: {
              ...visitWhere,
              scheduledFor: { gte: todayStart, lt: new Date(todayStart.getTime() + 24 * 60 * 60 * 1000) },
            },
          }),
          // visitsThisWeek: visits scheduled this week in scope, bucketed by day.
          this.visitsThisWeekBuckets(txClient, visitWhere, weekStart),
          // visitsLast7d: visits in the last 7 days (for noShowRate).
          txClient.siteVisit.findMany({
            where: { ...visitWhere, scheduledFor: { gte: sevenDaysAgo } },
            select: { status: true },
          }),
          // bookingsOnHold: bookings in HOLD state in scope.
          txClient.booking.count({
            where: { ...bookingWhere, status: 'HOLD' },
          }),
          // bookingsByStatus: bookings by status in scope.
          txClient.booking.groupBy({
            by: ['status'],
            where: bookingWhere,
            _count: { _all: true },
          }),
          // avgTimeToFirstTouch: avg minutes from Lead.createdAt to first
          // Activity (STATUS_CHANGE/CALL). null when no activity in scope.
          this.avgTimeToFirstTouch(txClient, leadWhere),
        ]);

        const visitsThisWeek = visitsThisWeekBuckets.reduce(
          (sum, b) => sum + b.count,
          0,
        );

        // Resolve owner names for teamPerformance.
        const ownerIds = teamPerformance.map((g) => g.ownerId);
        const owners =
          ownerIds.length > 0
            ? await txClient.user.findMany({
                where: { id: { in: ownerIds } },
                select: { id: true, name: true },
              })
            : [];
        const ownerNameById = new Map(owners.map((u) => [u.id, u.name]));

        // noShowRate: NO_SHOW / (COMPLETED + NO_SHOW) in last 7d, guard div-0.
        const completed = visitsLast7d.filter((v) => v.status === 'COMPLETED').length;
        const noShows = visitsLast7d.filter((v) => v.status === 'NO_SHOW').length;
        const denominator = completed + noShows;
        const noShowRate = denominator > 0 ? (noShows / denominator) * 100 : 0;

        return {
          kpis: {
            newLeadsToday,
            overdueLeads,
            visitsToday,
            visitsThisWeek,
            bookingsOnHold,
            noShowRate,
            avgTimeToFirstTouch,
          },
          pipeline: pipeline.map((g) => ({
            status: g.state,
            count: g._count._all,
          })),
          leadsOverTime: zeroFillDateRange(
            leadsOverTime.map((g) => ({
              key: isoDay(new Date(g.createdAt)),
              count: g._count._all,
            })),
            fourteenDaysAgo,
            14,
          ),
          leadSources: leadSources
            .filter((g) => g.source !== null)
            .map((g) => ({ source: g.source as string, count: g._count._all })),
          teamPerformance: teamPerformance.map((g) => ({
            ownerId: g.ownerId,
            ownerName: ownerNameById.get(g.ownerId) ?? 'Unknown',
            count: g._count._all,
          })),
          visitsThisWeek: zeroFillDateRange(
            visitsThisWeekBuckets,
            weekStart,
            7,
          ).map((b) => ({ day: b.date, count: b.count })),
          bookingsByStatus: bookingsByStatus.map((g) => ({
            status: g.status,
            count: g._count._all,
          })),
        };
      },
    );
  }

  /**
   * avgTimeToFirstTouch: average minutes from Lead.createdAt to the first
   * Activity (STATUS_CHANGE or CALL) for leads in scope. Returns null when no
   * activity rows exist (honest "no data", not a fabricated number).
   */
  private async avgTimeToFirstTouch(
    tx: PrismaClient,
    leadWhere: Record<string, unknown>,
  ): Promise<number | null> {
    // Find the earliest activity per lead in scope, then average the
    // (activity.createdAt - lead.createdAt) deltas. Bounded to leads in scope.
    const rows = await tx.$queryRaw<Array<{ deltaMin: number | null }>>`
      SELECT AVG(EXTRACT(EPOCH FROM (a."createdAt" - l."createdAt")) / 60) AS "deltaMin"
      FROM "Activity" a
      JOIN "Lead" l ON l."id" = a."leadId"
      WHERE a."type" IN ('STATUS_CHANGE', 'CALL')
        AND l."id" IN (SELECT "id" FROM "Lead" WHERE ${Prisma.raw(this.leadWhereSql(leadWhere))})
    `;
    const delta = rows[0]?.deltaMin;
    return delta === null || delta === undefined ? null : Math.round(delta);
  }

  /**
   * Convert a Prisma `where` object to a SQL fragment for the avgTimeToFirstTouch
   * subquery. Only supports the simple equality filters the dashboard uses
   * (projectId, ownerId, teamId) - never interpolates user input directly.
   */
  private leadWhereSql(where: Record<string, unknown>): string {
    const parts: string[] = [];
    if (typeof where['projectId'] === 'string') {
      parts.push(`"projectId" = '${where['projectId']}'`);
    }
    if (typeof where['ownerId'] === 'string') {
      parts.push(`"ownerId" = '${where['ownerId']}'`);
    }
    if (typeof where['teamId'] === 'string') {
      parts.push(`"teamId" = '${where['teamId']}'`);
    }
    return parts.length > 0 ? parts.join(' AND ') : 'TRUE';
  }

  /** visitsThisWeek buckets: group visits by scheduledFor day, Mon-Sun. */
  private async visitsThisWeekBuckets(
    tx: PrismaClient,
    visitWhere: Record<string, unknown>,
    weekStart: Date,
  ): Promise<Array<{ key: string; count: number }>> {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const rows = await tx.siteVisit.findMany({
      where: { ...visitWhere, scheduledFor: { gte: weekStart, lt: weekEnd } },
      select: { scheduledFor: true },
    });
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const key = isoDay(new Date(r.scheduledFor));
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.entries(counts).map(([key, count]) => ({ key, count }));
  }

  /**
   * GET /api/dashboard/overview - cross-project command center (T-OVERVIEW-STATS).
   *
   * ADMIN/OWNER only (service guard - the /overview route redirects non-admins
   * away, but the API must enforce it too). Cross-project: no projectId filter,
   * so the aggregates span ALL projects (RLS policies allow admin cross-tenant
   * reads). Returns the KPIs + charts the /overview page needs in one query.
   */
  async getOverviewStats(actor: JwtPayload): Promise<DashboardOverviewStats> {
    if (actor.role !== 'ADMIN' && actor.role !== 'OWNER') {
      throw new ForbiddenException(
        'Only ADMIN or OWNER can view the cross-project overview.',
      );
    }
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        const txClient = tx as unknown as PrismaClient;
        const now = new Date();
        const weekStart = startOfWeek(now);
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
        sevenDaysAgo.setHours(0, 0, 0, 0);
        // 90-day window for the audit-timeline area chart (the /overview
        // interactive chart offers 7d/30d/90d ranges; the backend returns the
        // full 90-day series zero-filled and the client filters by range).
        const ninetyDaysAgo = new Date(now);
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 89);
        ninetyDaysAgo.setHours(0, 0, 0, 0);
        const twentyFourHoursAgo = new Date(now);
        twentyFourHoursAgo.setHours(now.getHours() - 24);

        // Cross-project: no projectId filter. Admin/owner see all (RLS).
        const [totalLeads, reassignments7d, auditEvents24h, pipeline, usersByRole, visitsThisWeekBuckets, auditTimeline] =
          await Promise.all([
            txClient.lead.count(),
            txClient.auditLog.count({
              where: {
                action: 'lead.reassign',
                createdAt: { gte: sevenDaysAgo },
              },
            }),
            txClient.auditLog.count({
              where: { createdAt: { gte: twentyFourHoursAgo } },
            }),
            txClient.lead.groupBy({
              by: ['state'],
              _count: { _all: true },
            }),
            txClient.user.groupBy({
              by: ['role'],
              _count: { _all: true },
            }),
            this.visitsThisWeekBuckets(txClient, {}, weekStart),
            txClient.auditLog.groupBy({
              by: ['createdAt'],
              where: { createdAt: { gte: ninetyDaysAgo } },
              _count: { _all: true },
            }),
          ]);

        return {
          kpis: {
            totalLeads,
            reassignments7d,
            auditEvents24h,
            usersByRole: usersByRole.map((g) => ({
              role: g.role,
              count: g._count._all,
            })),
          },
          pipeline: pipeline.map((g) => ({
            status: g.state,
            count: g._count._all,
          })),
          visitsThisWeek: zeroFillDateRange(
            visitsThisWeekBuckets,
            weekStart,
            7,
          ).map((b) => ({ day: b.date, count: b.count })),
          auditTimeline: zeroFillDateRange(
            auditTimeline.map((g) => ({
              key: isoDay(new Date(g.createdAt)),
              count: g._count._all,
            })),
            ninetyDaysAgo,
            90,
          ),
        };
      },
    );
  }
}
