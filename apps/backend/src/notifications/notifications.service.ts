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
import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import {
  rlsContextFrom,
  withRlsContext,
  type PrismaClient,
} from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type { MarkReadDto, NotificationFilterDto } from '@shadhil/api-types';

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
  async list(
    actor: JwtPayload,
    dto: NotificationFilterDto,
  ): Promise<NotificationListResult> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const where: Record<string, unknown> = {};
        if (dto.unreadOnly) where['read'] = false;
        if (dto.type !== undefined) where['type'] = dto.type;
        // Prefix filter (e.g. 'lead' → lead.created, lead.transition).
        // Enables the Leads/Bookings/Visits tabs, which each span multiple
        // concrete notification types.
        if (dto.typePrefix !== undefined && dto.typePrefix.length > 0) {
          where['type'] = { startsWith: dto.typePrefix };
        }
        // T-ProjectSwitch: scope the inbox to the active project via the
        // related lead. Notification has NO `lead` relation field (only
        // leadId), so resolve the project's lead ids first (RLS-filtered)
        // and narrow with leadId IN. Notifications without a lead (system
        // events) are hidden under a project filter - not project work.
        if (dto.projectId !== undefined) {
          const projectLeads = await (tx as unknown as PrismaClient).lead.findMany({
            where: { projectId: dto.projectId },
            select: { id: true },
          });
          where['leadId'] = {
            in: projectLeads.map((l: { id: string }) => l.id),
          };
        }

        const [rows, total, unread] = await Promise.all([
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
          (tx as unknown as PrismaClient).notification.count({ where }),
          (tx as unknown as PrismaClient).notification.count({
            where: { read: false },
          }),
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
      },
    );
  }

  /**
   * PATCH /api/notifications/mark-read - mark a batch (or all, when
   * the IDs array is empty) of the actor's notifications as read.
   * Returns the number of rows updated.
   */
  async markRead(
    actor: JwtPayload,
    dto: MarkReadDto,
  ): Promise<{ updated: number }> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const where: Record<string, unknown> = {
          userId: actor.sub,
          read: false,
        };
        // Empty array = "mark all". Otherwise narrow to the listed
        // ids (the IN clause also serves as the audit boundary).
        if (dto.notificationIds.length > 0) {
          where['id'] = { in: dto.notificationIds };
        }

        const result = await (tx as unknown as PrismaClient).notification.updateMany(
          {
            where,
            data: { read: true },
          },
        );

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
      },
    );
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
    },
  ): Promise<NotificationRow> {
    if (recipientSub.trim().length === 0) {
      throw new BadRequestException('recipientSub is required');
    }
    return withRlsContext(
      this.client,
      { userId: recipientSub, role: 'TELECALLER', organizationId: process.env['PUBLIC_ORG_ID'] ?? '' },
      async (tx) => {
        const created = await (tx as unknown as PrismaClient).notification.create({
          data: {
            userId: recipientSub,
            organizationId: process.env['PUBLIC_ORG_ID'] ?? '',
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
            organizationId: process.env['PUBLIC_ORG_ID'] ?? '',
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
   * Best-effort web push alongside an in-app notification (rule 7j). Never
   * throws to the caller. No-ops when the push dep is absent (test harness)
   * or push is disabled (no VAPID keys).
   */
  private pushBestEffort(
    recipientSub: string,
    payload: { title: string; body: string; leadId?: string },
  ): void {
    if (this.push === undefined) return;
    try {
      void this.push
        .sendToUser(recipientSub, {
          title: payload.title,
          body: payload.body,
          url: payload.leadId !== undefined ? `/leads/${payload.leadId}` : undefined,
        })
        .catch(() => undefined);
    } catch {
      // swallow - best-effort
    }
  }
}
