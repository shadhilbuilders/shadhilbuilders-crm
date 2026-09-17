// Per-channel fetchers.
//
// Each function returns a Fetcher: (lastSeenAt: Date) => Promise<SseFrame[]>
// that the stream pipeline calls on every DB_TICK_MS. Fetchers MUST
// return frames ordered ascending by creation time (the pipeline
// appends them in order).
//
// T-E2 (Week 6, 2026-09-04). The port of the broken Nest controller's
// data fetchers - these run inside the working setInterval loop in
// server.ts, not inside a Nest @Sse() executor.
//
// T-E2-REALTIME-RLS (2026-09-17): EVERY query here MUST run inside
// withRlsContext(). Message / Notification / AuditLog all have ROW
// LEVEL SECURITY enabled and their SELECT policies gate on the
// per-transaction GUCs withRlsContext sets (app.user_id /
// app.user_role / app.user_org_id). A bare prisma.findMany with no
// GUCs is filtered to ZERO rows - current_setting(name, true) yields
// NULL when unset and no policy matches NULL. That is exactly the
// "SSE opens + polls but the chat never updates live" bug: the
// fetcher saw nothing, so it emitted no frame. We resolve the
// consuming user's role + org (User is NOT row-level secured, so it
// is readable on the bare client) and scope every fetch to that actor.

import type { PrismaClient, Role } from '@shadhil/database';
import { withRlsContext } from '@shadhil/database';
import type { SseFrame } from './stream.js';

const FETCH_BATCH = 50;

/** RLS context for the stream ticket's subject (the logged-in user). */
export interface SseUser {
  userId: string;
  role: Role;
  organizationId: string;
}

/**
 * Resolve the RLS context for the consuming user. The User table is not
 * row-level secured (auth tables stay non-RLS like Session/Account), so
 * its role + org are readable on the bare client. These feed the same
 * withRlsContext(actor) that every backend request uses - without them
 * the Message/Notification/AuditLog fetches are RLS-filtered to empty.
 * Fails closed (empty org) if the user row vanished, so no cross-tenant
 * leak.
 */
export async function resolveUserContext(
  prisma: PrismaClient,
  userId: string,
): Promise<SseUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, organizationId: true },
  });
  if (user === null) {
    return { userId, role: 'TELECALLER', organizationId: '' };
  }
  return {
    userId,
    role: user.role,
    organizationId: user.organizationId,
  };
}

/** Notifications fetcher - emits one frame per row. */
export const notificationsFetcher =
  (prisma: PrismaClient, user: SseUser) =>
  async (lastSeenAt: Date): Promise<SseFrame[]> => {
    const rows = await withRlsContext(
      prisma,
      { userId: user.userId, role: user.role, organizationId: user.organizationId },
      async (tx) =>
        tx.notification.findMany({
          where: { userId: user.userId, createdAt: { gt: lastSeenAt } },
          orderBy: { createdAt: 'asc' },
          take: FETCH_BATCH,
        }),
    );
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

/** Audit fetcher - emits one frame per row. Schema: AuditLog uses
 *  `userId` (the actor) + `before`/`after` Json diffs, not `actorId`
 *  + `metadata`. The role check matches the legacy Nest controller:
 *  ADMIN/OWNER see all rows; everyone else sees only their own. */
export const auditFetcher =
  (prisma: PrismaClient, user: SseUser) =>
  async (lastSeenAt: Date): Promise<SseFrame[]> => {
    const seeAll = user.role === 'ADMIN' || user.role === 'OWNER';
    const rows = await withRlsContext(
      prisma,
      { userId: user.userId, role: user.role, organizationId: user.organizationId },
      async (tx) =>
        tx.auditLog.findMany({
          where: {
            createdAt: { gt: lastSeenAt },
            ...(seeAll ? {} : { userId: user.userId }),
          },
          orderBy: { createdAt: 'asc' },
          take: FETCH_BATCH,
        }),
    );
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

/** Chat fetcher - emits one frame per Message for the given lead. */
export const chatFetcher =
  (prisma: PrismaClient, user: SseUser, leadId: string) =>
  async (lastSeenAt: Date): Promise<SseFrame[]> => {
    const rows = await withRlsContext(
      prisma,
      { userId: user.userId, role: user.role, organizationId: user.organizationId },
      async (tx) =>
        tx.message.findMany({
          where: { leadId, createdAt: { gt: lastSeenAt } },
          orderBy: { createdAt: 'asc' },
          take: FETCH_BATCH,
        }),
    );
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
