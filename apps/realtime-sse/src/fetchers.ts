// Per-channel fetchers.
//
// Each function returns a Fetcher: (lastSeenAt: Date) => Promise<SseFrame[]>
// that the stream pipeline calls on every DB_TICK_MS. Fetchers MUST
// return frames ordered ascending by creation time (the pipeline
// appends them in order).
//
// T-E2 (Week 6, 2026-09-04). The port of the broken Nest controller's
// data fetchers — these run inside the working setInterval loop in
// server.ts, not inside a Nest @Sse() executor.

import type { PrismaClient } from '@shadhil/database';
import type { SseFrame } from './stream.js';

const FETCH_BATCH = 50;

/** Notifications fetcher — emits one frame per row. */
export const notificationsFetcher =
  (prisma: PrismaClient, userId: string) =>
  async (lastSeenAt: Date): Promise<SseFrame[]> => {
    const rows = await prisma.notification.findMany({
      where: { userId, createdAt: { gt: lastSeenAt } },
      orderBy: { createdAt: 'asc' },
      take: FETCH_BATCH,
    });
    return rows.map((n) => ({
      id: n.id,
      data: {
        id: n.id,
        userId: n.userId,
        type: n.type,
        title: n.title,
        body: n.body,
        leadId: n.leadId,
        read: n.read,
        createdAt: n.createdAt.toISOString(),
      },
    }));
  };

/** Audit fetcher — emits one frame per row. Schema: AuditLog uses
 *  `userId` (the actor) + `before`/`after` Json diffs, not `actorId`
 *  + `metadata`. The role check matches the legacy Nest controller:
 *  ADMIN/OWNER see all rows; everyone else sees only their own. */
export const auditFetcher =
  (prisma: PrismaClient, userId: string) =>
  async (lastSeenAt: Date): Promise<SseFrame[]> => {
    const owner = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    const seeAll = owner?.role === 'ADMIN' || owner?.role === 'OWNER';
    const rows = await prisma.auditLog.findMany({
      where: {
        createdAt: { gt: lastSeenAt },
        ...(seeAll ? {} : { userId }),
      },
      orderBy: { createdAt: 'asc' },
      take: FETCH_BATCH,
    });
    return rows.map((a) => ({
      id: a.id,
      data: {
        id: a.id,
        userId: a.userId,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        before: a.before,
        after: a.after,
        reason: a.reason,
        createdAt: a.createdAt.toISOString(),
      },
    }));
  };

/** Chat fetcher — emits one frame per Message for the given lead. */
export const chatFetcher =
  (prisma: PrismaClient, leadId: string) =>
  async (lastSeenAt: Date): Promise<SseFrame[]> => {
    const rows = await prisma.message.findMany({
      where: { leadId, createdAt: { gt: lastSeenAt } },
      orderBy: { createdAt: 'asc' },
      take: FETCH_BATCH,
    });
    return rows.map((m) => ({
      id: m.id,
      data: {
        id: m.id,
        leadId: m.leadId,
        direction: m.direction,
        channel: m.channel,
        body: m.body,
        mediaUrl: m.mediaUrl,
        createdAt: m.createdAt.toISOString(),
      },
    }));
  };
