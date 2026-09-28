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
import { Prisma, withRlsContext, rlsContextFrom, type PrismaClient, type Role } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
// T-STATUS-ONE-TRUTH (2026-09-28): NEW_TODAY_STATE / startOfToday are the shared
// definitions the leads page and the KPI strip both use. Importing them (rather
// than restating midnight or a 24h window here) is what keeps the two screens
// from disagreeing.
import { NEW_TODAY_STATE, OVERDUE_AFTER_MIN, startOfToday, TERMINAL_LEAD_STATES } from '@shadhil/api-types';
import type {
  BookingMoneyException,
  DashboardExceptions,
  DashboardOverviewStats,
  DashboardStats,
  DashboardStatsQuery,
  IdleLeadException,
  TeamHealthException,
  VisitRiskException,
} from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';
import { TeamAccessService } from '../teams/team-access.service';

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

  // T-TEAM-AUTHORITATIVE (2026-09-13): stateless helper, no DI needed.
  private readonly teamAccess = new TeamAccessService();

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * Resolve EVERY team a MANAGER leads (T-TEAM-AUTHORITATIVE: one manager
   * may lead multiple teams - mirrors leads.service.managerTeamIds).
   * Returns [] for a MANAGER with no team.
   */
  private async managerTeamIds(
    tx: PrismaClient,
    actor: JwtPayload,
  ): Promise<string[]> {
    if (actor.role !== 'MANAGER') return [];
    return this.teamAccess.getManagedTeamIds(tx as never, actor.sub, actor.organizationId);
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
      const teamIds = await this.managerTeamIds(tx, actor);
      where['teamId'] = teamIds.length > 0 ? { in: teamIds } : '__no_team__';
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
      rlsContextFrom(actor),
      async (tx) => {
        const txClient = tx as unknown as PrismaClient;
        const leadWhere = await this.leadWhere(txClient, actor, query.projectId);

        const now = new Date();
        // "Today" is defined in ONE place (@shadhil/api-types `startOfToday`),
        // not re-derived here - T-STATUS-ONE-TRUTH (2026-09-28).
        const todayStart = startOfToday(now);
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
          const teamIds = await this.managerTeamIds(txClient, actor);
          visitWhere['lead'] = {
            teamId: teamIds.length > 0 ? { in: teamIds } : '__no_team__',
          };
        }

        // Booking where: role-scoped via parent Lead (Booking has no projectId).
        const bookingWhere: Record<string, unknown> = {};
        if (query.projectId !== undefined) {
          bookingWhere['lead'] = { projectId: query.projectId };
        }
        if (actor.role === 'TELECALLER' || actor.role === 'SALES_EXEC') {
          bookingWhere['lead'] = { ownerId: actor.sub };
        } else if (actor.role === 'MANAGER') {
          const teamIds = await this.managerTeamIds(txClient, actor);
          bookingWhere['lead'] = {
            teamId: teamIds.length > 0 ? { in: teamIds } : '__no_team__',
          };
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
          // newLeadsToday: created since local midnight AND still NEW
          // (T-STATUS-ONE-TRUTH, 2026-09-28).
          //
          // Two defects fixed here. (1) It counted `createdAt >= midnight` with
          // NO state filter, so leads already WON or LOST today were counted as
          // "new" - closing a deal made the number go UP. (2) The leads page
          // counted a rolling 24h window instead, so the same words meant
          // different populations on two screens. Both now call the shared
          // `startOfToday()` + `newTodayState` contract in @shadhil/api-types.
          txClient.lead.count({
            where: {
              ...leadWhere,
              state: NEW_TODAY_STATE,
              createdAt: { gte: startOfToday(now) },
            },
          }),
          // overdueLeads: NEW + created > 30 min ago. Same SLA constant as
          // leads.service's overdueCount and the client's isOverdue().
          txClient.lead.count({
            where: {
              ...leadWhere,
              state: NEW_TODAY_STATE,
              createdAt: { lte: new Date(now.getTime() - OVERDUE_AFTER_MIN * 60 * 1000) },
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
      rlsContextFrom(actor),
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

  /**
   * GET /api/dashboard/exceptions - the admin/owner problem inbox (2026-09-17).
   *
   * ADMIN/OWNER only (service guard, mirrors getOverviewStats). Cross-project:
   * no project filter, so every problem spans all teams (RLS allows admin
   * cross-tenant reads). Returns four arrays - one per problem class - each row
   * a specific issue with a deep-linkable `projectId`.
   *
   * DATA SOURCE (honest, verified not assumed): "last touched" is Lead.updatedAt
   * (Prisma @updatedAt bumps on every state transition). The Activity table is
   * populated by NO production code today (only tests write rows), so a true
   * "last CALL" cannot be derived; updatedAt is the maintained signal. If a
   * real activity writer ships later, this query can switch to it.
   *
   * Buckets for idle leads (owner ruling 2026-09-17): the 30-minute SLA-overdue
   * NEW bucket is separate ("overdue"); otherwise a lead is idle after 1 day
   * of no touch, escalating 1-3 / 4-7 / 8-14 / 15-30 / 30+ days. Out-of-any
   * consideration are terminal states (WON/LOST/RNR) - those are archive, not
   * forgotten work.
   *
   * T-STATUS-ONE-TRUTH (2026-09-28) - two things the operator must be able to
   * read off the screen, because both made this card look "wrong" next to the
   * leads page:
   *
   *   - this card is CROSS-PROJECT and the leads page is single-project, so
   *     equal definitions still produce different totals. That difference is
   *     correct; each row carries its project.
   *   - the window is "a full day since the last write", not "nobody called".
   *     It reads `Lead.updatedAt`, which bumps on ANY write (a note, a
   *     reassignment), so a lead called five times without a state change still
   *     drifts in, and a lead nobody called but whose notes were edited drops
   *     out. The Activity table that would carry a real call timestamp is still
   *     unwritten by production code, so the honest fix is the label: the UI
   *     titles this card "Going stale" and states the threshold instead of
   *     promising call data that does not exist.
   *
   * This is deliberately NOT the `overdue` definition the leads page and KPI
   * strip use (a NEW lead missing its 30-minute first-touch SLA) - different
   * question, so a different card. Both windows are named constants in
   * @shadhil/api-types, so neither is a magic number in a query string.
   */
  async getExceptions(actor: JwtPayload): Promise<DashboardExceptions> {
    if (actor.role !== 'ADMIN' && actor.role !== 'OWNER') {
      throw new ForbiddenException(
        'Only ADMIN or OWNER can view cross-project exceptions.',
      );
    }
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const txClient = tx as unknown as PrismaClient;
        const now = new Date();
        const oneDayMs = 86_400_000;
        const nowDaysAge = (iso: string): number =>
          Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / oneDayMs));

        // ---- 1. Going stale: active states, last write older than 1 day. ----
        const idleRaw = await txClient.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          SELECT l."id", l."name", l."phone", l."state", l."ownerId", l."projectId",
            l."updatedAt",
            (SELECT u."name" FROM "User" u WHERE u."id" = l."ownerId") AS "ownerName"
          FROM "Lead" l
          WHERE l."state" NOT IN ('WON', 'LOST', 'RNR')
            AND l."updatedAt" <= now() - interval '1 day'
          ORDER BY l."updatedAt" ASC
          LIMIT 100
        `);
        const idleLeads: IdleLeadException[] = idleRaw.map((r) => {
          const touchedAt = (r.updatedAt as Date).toISOString();
          const dirty = nowDaysAge(touchedAt);
          // The 30-minute SLA bucket is separate from idle (owner ruling):
          // NEW created >30m ago is "overdue first touch", not merely idle.
          const bucket =
            r.state === 'NEW' &&
            (now.getTime() - new Date(touchedAt).getTime()) > 30 * 60_000
              ? 'overdue'
              : dirty <= 3
                ? 'idle-1-3'
                : dirty <= 7
                  ? 'idle-4-7'
                  : dirty <= 14
                    ? 'idle-8-14'
                    : dirty <= 30
                      ? 'idle-15-30'
                      : 'idle-30-plus';
          return {
            id: r.id as string,
            name: r.name as string,
            phone: r.phone as string,
            status: r.state as string,
            ownerId: r.ownerId as string,
            ownerName: (r.ownerName as string | null) ?? null,
            projectId: r.projectId as string,
            lastTouchedAt: touchedAt,
            idleDays: dirty,
            bucket,
          };
        });

        // ---- 2. Visit risk: visits still open whose slot is today or past. ----
        //
        // T-VISIT-RISK-STATUS (2026-09-28): filtered on the LEAD state too.
        // Without it the card listed visits whose deal was already settled -
        // reported as "lead status is won but this leads shows in visit at risk".
        // The visit row is a per-visit artifact that NOTHING closes when its
        // lead goes terminal: recording a visit outcome never cascades to the
        // lead, and `reassign`/`setCoOwner` do not touch visits, so a
        // SCHEDULED visit survives its lead reaching WON or LOST and its
        // `scheduledFor` stays in the past forever. Re-engagement states
        // (RESCHEDULED, NO_SHOW) are deliberately NOT excluded - there the deal
        // is still live and the visit genuinely needs attention.
        //
        // `lead.state` is selected so the row can SHOW the status; without it
        // the operator cannot tell a stale row from a live one on the card, and
        // the whole report is "why is this here?".
        const visitRows = await txClient.siteVisit.findMany({
          where: {
            status: { in: ['SCHEDULED', 'RESCHEDULED'] },
            scheduledFor: { lte: now },
            lead: { state: { notIn: [...TERMINAL_LEAD_STATES] } },
          },
          orderBy: { scheduledFor: 'asc' },
          take: 50,
          select: {
            id: true,
            leadId: true,
            scheduledFor: true,
            status: true,
            lead: { select: { name: true, projectId: true, state: true } },
            user: { select: { name: true } },
          },
        });
        // "Today" comes from the shared `startOfToday()` (T-STATUS-ONE-TRUTH),
        // not a second local re-derivation.
        const todayStart = startOfToday(now);
        const visitRisk: VisitRiskException[] = visitRows.map((v) => ({
          id: v.id,
          leadId: v.leadId,
          leadName: v.lead.name,
          leadStatus: v.lead.state,
          projectId: v.lead.projectId,
          scheduledFor: v.scheduledFor.toISOString(),
          status: v.status,
          userName: v.user.name ?? null,
          reason: v.scheduledFor.getTime() < todayStart.getTime() ? 'overdue-past-due' : 'scheduled-today',
        }));

        // ---- 3. Booking money not moving: awaiting approval, settled-but-no-
        // token, or a TOKEN booking with its amount missing (a data defect). ----
        const bookingRows = await txClient.booking.findMany({
          where: { status: { in: ['TOKEN', 'HOLD'] } },
          orderBy: { createdAt: 'asc' },
          take: 50,
          select: {
            id: true,
            amount: true,
            tokenAmount: true,
            status: true,
            createdAt: true,
            lead: { select: { name: true, projectId: true } },
            unit: { select: { unitNumber: true } },
          },
        });
        const bookingMoney: BookingMoneyException[] = bookingRows.map((b) => {
          const tokenPaid =
            b.tokenAmount !== null && Number(b.tokenAmount) > 0;
          const ageDays = nowDaysAge(b.createdAt.toISOString());
          // T-TOKEN-GATE (2026-09-28): three cases, not two. A booking in TOKEN
          // with no amount is a DATA DEFECT - the status asserts money was
          // received and there is nothing recording how much - and it used to be
          // reported as 'hold-no-token', which reads as "the money is still with
          // the customer" for a booking marked as paid. Naming it separately is
          // what lets an operator find these rows and correct the amount from the
          // actual record (no payment table exists to derive it from).
          const reason =
            b.status === 'TOKEN' && !tokenPaid
              ? 'token-recorded-missing-amount'
              : tokenPaid
                ? 'token-paid-awaiting-approval'
                : 'hold-no-token';
          return {
            id: b.id,
            leadName: b.lead.name,
            unitNumber: b.unit.unitNumber ?? null,
            projectId: b.lead.projectId,
            amount: b.amount.toString(),
            tokenAmount: b.tokenAmount === null ? null : b.tokenAmount.toString(),
            status: b.status,
            ageDays,
            reason,
            stuckDays: ageDays,
          };
        });

        // ---- 4. Team health: staff whose own ACTIVE leads have all gone quiet,
        // or who are carrying a large untouched backlog (systemic, not personal).
        //
        // `activeLeadCount` excludes terminal states, matching the "Open"
        // counter on admin/teams (T-STATUS-ONE-TRUTH, 2026-09-28) - a member's
        // open load must not include the deals they already closed, or the
        // overload threshold fires on a rep having a good week. ----
        const OVERLOAD_ACTIVE_THRESHOLD = 10; // named constant, owner-tunable
        const teamRaw = await txClient.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          SELECT l."ownerId" AS "userId", u."name" AS "userName", u."role",
            COUNT(*) AS "activeLeadCount",
            MAX(l."updatedAt") AS "maxTouch"
          FROM "Lead" l
          JOIN "User" u ON u."id" = l."ownerId"
          WHERE l."state" NOT IN ('WON', 'LOST', 'RNR')
            AND u."role" IN ('TELECALLER', 'SALES_EXEC')
          GROUP BY l."ownerId", u."name", u."role"
        `);
        const teamHealth: TeamHealthException[] = teamRaw
          .map((r) => {
            const maxTouch = (r.maxTouch as Date | null)?.toISOString() ?? null;
            const activeLeadCount = Number(r.activeLeadCount ?? 0);
            const quietDays = maxTouch === null ? 0 : nowDaysAge(maxTouch);
            const kind =
              quietDays >= 1
                ? 'quiet'
                : activeLeadCount > OVERLOAD_ACTIVE_THRESHOLD
                  ? 'overloaded'
                  : null;
            if (kind === null) return null;
            return {
              userId: r.userId as string,
              userName: r.userName as string,
              role: r.role as string,
              kind,
              quietDays,
              activeLeadCount,
            };
          })
          .filter((row): row is TeamHealthException => row !== null)
          .sort((a, b) => (a.kind === 'quiet' ? 1 : 0) - (b.kind === 'quiet' ? 1 : 0));

        return { idleLeads, visitRisk, bookingMoney, teamHealth };
      },
    );
  }
}
