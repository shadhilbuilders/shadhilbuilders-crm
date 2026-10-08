// Notifications service - REST surface for the in-app inbox.
//
// T-NOTIF (2026-09-07): replaces the Phase-1 stub. The web page
// already wires to GET /api/notifications and PATCH
// /api/notifications/mark-read via useNotifications +
// useMarkNotificationsRead; this module lights them up.
//
// RLS: owner-only SELECT/UPDATE/DELETE policies gate correctly
// (see packages/database/prisma/rls/policies.sql - the
// notification_select_owner / notification_update_owner /
// notification_delete_owner trio). The notification_insert_owner
// policy (added in commit a905d1c) lets a user write their own
// notifications. No new policy needed for T-NOTIF.
//
// Write paths (all inside `withRlsContext`):
//   - markRead: updateMany({id: {in: ids}, userId: actor.sub, read: false})
//     → {read: true}. RLS UPDATE policy gates via userId match.
//   - markAllRead: same as markRead but with empty ids (we update
//     every unread row the actor owns).
//
// The notification emit (creating a new Notification row) happens
// elsewhere - this module only READS + MARKS. The AuditLog row is
// written on every markRead mutation for the demo trail.
import { LEAD_IN_ACTIVE_PROJECT } from '../common/soft-delete-filters';
import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { rlsContextFrom, withRlsContext, type PrismaClient } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type { MarkReadDto, NotificationFilterDto } from '@shadhil/api-types';

import { cronContextFor } from '../common/cron-orgs';
import { PrismaService } from '../prisma/prisma.module';
import { PushService } from '../push/push.service';

/**
 * Wire shape returned by every endpoint. Matches the
 * NotificationEvent schema in packages/api-types/src/notifications.ts
 * - the web app reads these fields off `query.data` in
 * apps/web/src/app/(app)/notifications/page.tsx.
 */
export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  leadId: string | null;
  read: boolean;
  createdAt: string;
}

export type NotificationListResult = {
  total: number;
  unread: number;
  rows: NotificationRow[];
};

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    // @Optional() (rule 7h): the push dep is best-effort. Existing test
    // factories construct NotificationsService with one arg; optional keeps
    // them green. Production DI resolves via @Global() PushModule.
    @Optional()
    @Inject(PushService)
    private readonly push?: PushService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * GET /api/notifications?unreadOnly=true - current user's
   * notifications, newest first. The notification_select_owner RLS
   * policy limits visibility to the actor's own rows; no extra
   * role-scoping needed.
   */
  async list(actor: JwtPayload, dto: NotificationFilterDto): Promise<NotificationListResult> {
    const baseWhere: Record<string, unknown> = {};
    if (dto.unreadOnly) baseWhere['read'] = false;
    if (dto.type !== undefined) baseWhere['type'] = dto.type;
    // Prefix filter (e.g. 'lead' → lead.created, lead.transition).
    // Enables the Leads/Bookings/Visits tabs, which each span multiple
    // concrete notification types.
    if (dto.typePrefix !== undefined && dto.typePrefix.length > 0) {
      baseWhere['type'] = { startsWith: dto.typePrefix };
    }
    // T-ProjectSwitch: scope the inbox to the active project via the related
    // lead. Notification has NO `lead` relation field (only leadId), so
    // resolve the project's lead ids first (RLS-filtered) and narrow with
    // leadId IN. Notifications without a lead (system events) are hidden under
    // a project filter - not project work.
    if (dto.projectId !== undefined) {
      const projectLeads = await withRlsContext(this.client, rlsContextFrom(actor), (tx) =>
        (tx as unknown as PrismaClient).lead.findMany({
          // T-SOFT-DELETE (2026-10-01): the project filter is expressed as
          // "notifications for this project's leads", so a lead on a
          // soft-deleted project must not pull its notifications back in.
          where: { projectId: dto.projectId, ...LEAD_IN_ACTIVE_PROJECT },
          select: { id: true },
        }),
      );
      baseWhere['leadId'] = {
        in: projectLeads.map((l: { id: string }) => l.id),
      };
    }

    const where = baseWhere;

    // Run the three reads IN PARALLEL, each in its OWN withRlsContext
    // transaction. @prisma/adapter-pg pins ONE pooled pg client per
    // transaction, so concurrent `.query()` calls inside a SINGLE transaction
    // hit the same pinned client and trip pg's "client.query() while already
    // executing" deprecation (pg@9 will throw). Firing each query in its own
    // transaction lets them grab DIFFERENT pooled connections - genuinely
    // parallel AND warning-free.
    const [rows, total, unread] = await Promise.all([
      withRlsContext(this.client, rlsContextFrom(actor), (tx) =>
        (tx as unknown as PrismaClient).notification.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: dto.limit,
          skip: dto.offset,
          select: {
            id: true,
            type: true,
            title: true,
            body: true,
            leadId: true,
            read: true,
            createdAt: true,
          },
        }),
      ),
      withRlsContext(this.client, rlsContextFrom(actor), (tx) =>
        (tx as unknown as PrismaClient).notification.count({ where }),
      ),
      withRlsContext(this.client, rlsContextFrom(actor), (tx) =>
        (tx as unknown as PrismaClient).notification.count({
          where: { read: false },
        }),
      ),
    ]);

    return {
      total,
      unread,
      rows: rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        body: r.body,
        leadId: r.leadId,
        read: r.read,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /**
   * PATCH /api/notifications/mark-read - mark a batch (or all, when
   * the IDs array is empty) of the actor's notifications as read.
   * Returns the number of rows updated.
   */
  async markRead(actor: JwtPayload, dto: MarkReadDto): Promise<{ updated: number }> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const where: Record<string, unknown> = {
        userId: actor.sub,
        read: false,
      };
      // Empty array = "mark all". Otherwise narrow to the listed
      // ids (the IN clause also serves as the audit boundary).
      if (dto.notificationIds.length > 0) {
        where['id'] = { in: dto.notificationIds };
      }

      const result = await (tx as unknown as PrismaClient).notification.updateMany({
        where,
        data: { read: true },
      });

      await (tx as unknown as PrismaClient).auditLog.create({
        data: {
          userId: actor.sub,
          organizationId: actor.organizationId,
          action: 'notification.markRead',
          entityType: 'Notification',
          entityId: 'batch',
          after: {
            updated: result.count,
            scope: dto.notificationIds.length === 0 ? 'all-unread' : 'specified',
          },
          reason: `Marked ${result.count} notifications as read by ${actor.email} (${actor.role})`,
        },
      });

      return { updated: result.count };
    });
  }

  /**
   * Service hook for emitting a new notification. Other modules
   * (leads, visits, bookings) call this when an event happens that
   * should land in the recipient's inbox.
   *
   * Audit row written alongside the notification row (the prompt
   * specifies notification emit = auditable event).
   *
   * The notification_insert_owner RLS policy requires userId =
   * app.user_id. The caller passes the recipient's userId; the actor
   * here is the system, so we set app.user_id = recipient.sub. This
   * means the actor's identity in the audit row is the recipient, not
   * the originator - a downstream module can pass originatorSub
   * separately if it wants a different audit attribution. For Pass 1
   * we use the recipient (matches the "owner writes their own
   * notification" RLS intent).
   */
  async emit(
    recipientSub: string,
    payload: {
      type: string;
      title: string;
      body: string;
      leadId?: string;
      /** Present for booking notifications so the push deep-links to the
       *  booking page (`/bookings/{bookingId}`) rather than the lead's. */
      bookingId?: string;
      /** Tenant of the recipient. Optional: when omitted it is read from the
       *  recipient's own User row, never from PUBLIC_ORG_ID (T-CRON-MULTITENANT). */
      organizationId?: string;
    },
  ): Promise<NotificationRow> {
    if (recipientSub.trim().length === 0) {
      throw new BadRequestException('recipientSub is required');
    }
    const organizationId = payload.organizationId ?? (await this.resolveRecipientOrg(recipientSub));
    return withRlsContext(
      this.client,
      { userId: recipientSub, role: 'TELECALLER', organizationId },
      async (tx) => {
        const created = await (tx as unknown as PrismaClient).notification.create({
          data: {
            userId: recipientSub,
            organizationId,
            type: payload.type,
            title: payload.title,
            body: payload.body,
            ...(payload.leadId !== undefined ? { leadId: payload.leadId } : {}),
            read: false,
          },
          select: {
            id: true,
            type: true,
            title: true,
            body: true,
            leadId: true,
            read: true,
            createdAt: true,
          },
        });

        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: recipientSub,
            organizationId,
            action: 'notification.emit',
            entityType: 'Notification',
            entityId: created.id,
            after: {
              type: created.type,
              leadId: created.leadId,
            },
            reason: `Notification "${created.type}" emitted to user ${recipientSub}`,
          },
        });

        // Fire a web push alongside the in-app notification (best-effort).
        this.pushBestEffort(recipientSub, {
          title: created.title,
          body: created.body,
          leadId: created.leadId ?? undefined,
          bookingId: payload.bookingId,
          organizationId,
        });

        return {
          id: created.id,
          type: created.type,
          title: created.title,
          body: created.body,
          leadId: created.leadId,
          read: created.read,
          createdAt: created.createdAt.toISOString(),
        };
      },
    );
  }

  /**
   * The recipient's organization, read from their own User row. User has no
   * RLS, so the bare client is correct here. A missing user or one without an
   * org is a caller bug and fails loudly rather than guessing a tenant.
   */
  private async resolveRecipientOrg(recipientSub: string): Promise<string> {
    const user = await this.client.user.findUnique({
      where: { id: recipientSub },
      select: { organizationId: true },
    });
    if (user === null || user.organizationId.length === 0) {
      throw new BadRequestException(
        `Cannot resolve the organization for notification recipient ${recipientSub}`,
      );
    }
    return user.organizationId;
  }

  /**
   * Best-effort web push alongside an in-app notification (rule 7j). Never
   * throws to the caller. No-ops when the push dep is absent (test harness)
   * or push is disabled (no VAPID keys).
   *
   * The deep-link URL is the app's REAL route, resolved server-side from the
   * notification's entity (lead -> project -> org, or booking -> lead's
   * project/org for booking notifications). NOT a bare `/leads/{id}` or
   * `/bookings/{id}`, which the app doesn't route. Falls back to '/' when the
   * entity can't be resolved so a click still lands somewhere safe.
   */
  private pushBestEffort(
    recipientSub: string,
    payload: {
      title: string;
      body: string;
      leadId?: string;
      bookingId?: string;
      organizationId: string;
    },
  ): void {
    if (this.push === undefined) return;
    try {
      void (async () => {
        const url =
          payload.bookingId !== undefined
            ? await this.resolveBookingDeepLink(
                payload.organizationId,
                payload.leadId,
                payload.bookingId,
              )
            : payload.leadId !== undefined
              ? await this.resolveLeadDeepLink(payload.organizationId, payload.leadId)
              : undefined;
        await this.push
          ?.sendToUser(
            recipientSub,
            { title: payload.title, body: payload.body, url },
            payload.organizationId,
          )
          .catch(() => undefined);
      })().catch(() => undefined);
    } catch {
      // swallow - best-effort
    }
  }

  /** Resolve the app-route deep-link for a lead, or '/' if unresolvable. */
  private async resolveLeadDeepLink(organizationId: string, leadId: string): Promise<string> {
    try {
      // RLS: the lead read MUST run inside withRlsContext, or the bare client's
      // session GUCs (app.user_* ) are all NULL and no SELECT policy matches -
      // findUnique returns null and every push falls back to '/'. We read as
      // CRON_SERVICE (the org-scoped service-account bypass: policies on Lead,
      // Organization, Project all admit role=CRON_SERVICE within the org) so
      // the deep-link resolves identically no matter who the recipient is -
      // a TELECALLER/MANAGER/OWNER context would only see leads their own role
      // policy admits, which is the wrong gate for building a push link.
      const lead = await withRlsContext(this.client, cronContextFor(organizationId), (tx) =>
        (tx as unknown as PrismaClient).lead.findUnique({
          where: { id: leadId },
          select: {
            project: { select: { slug: true } },
            organization: { select: { slug: true } },
          },
        }),
      );
      const orgSlug = lead?.organization?.slug;
      const projectSlug = lead?.project?.slug;
      if (orgSlug === undefined || projectSlug === undefined) return '/';
      return `/${orgSlug}/projects/${projectSlug}/leads/${leadId}`;
    } catch {
      return '/';
    }
  }

  /** Resolve the app-route deep-link for a booking, or '/' if unresolvable.
   *  Booking rows have no CRON_SERVICE SELECT policy, so the org+project slugs
   *  are derived from the booking's lead (which CRON_SERVICE can read) - no new
   *  RLS policy needed. Falls back to the lead page if the booking's lead is
   *  missing but the booking id is still present. */
  private async resolveBookingDeepLink(
    organizationId: string,
    leadId: string | undefined,
    bookingId: string,
  ): Promise<string> {
    const orgSlug =
      leadId !== undefined ? await this.resolveLeadOrgProjectSlugs(organizationId, leadId) : null;
    if (orgSlug !== null && orgSlug.orgSlug !== undefined && orgSlug.projectSlug !== undefined) {
      return `/${orgSlug.orgSlug}/projects/${orgSlug.projectSlug}/bookings/${bookingId}`;
    }
    if (leadId !== undefined) {
      const fallback = await this.resolveLeadDeepLink(organizationId, leadId);
      if (fallback !== '/') return fallback;
    }
    return '/';
  }

  /** Resolve a lead's org + project slugs via CRON_SERVICE context (or null). */
  private async resolveLeadOrgProjectSlugs(
    organizationId: string,
    leadId: string,
  ): Promise<{ orgSlug?: string; projectSlug?: string } | null> {
    try {
      const lead = await withRlsContext(this.client, cronContextFor(organizationId), (tx) =>
        (tx as unknown as PrismaClient).lead.findUnique({
          where: { id: leadId },
          select: {
            project: { select: { slug: true } },
            organization: { select: { slug: true } },
          },
        }),
      );
      return {
        orgSlug: lead?.organization?.slug,
        projectSlug: lead?.project?.slug,
      };
    } catch {
      return null;
    }
  }
}
