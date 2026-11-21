// Per-channel fetchers.
//
// Each function returns a Fetcher: (cursor: StreamCursor) => Promise<CursorFrame[]>
// that the stream pipeline calls on every DB_TICK_MS. Fetchers MUST return
// frames ordered ascending by (createdAt, id) - the pipeline advances its
// cursor to the maximum emitted tuple, so the DB order and the cursor order
// have to agree or the window between pages is undefined.
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
//
// T-SSE-ANCHOR (2026-11-21): the filter is a (createdAt, id) CURSOR, not
// `createdAt > lastSeenAt`. See cursor.ts for the lost-row bug this closes.
// The `OR ... AND` below is the tuple comparison
// `(createdAt, id) > (cursor.createdAt, cursor.id)` spelled out, because
// Prisma cannot express a row-value comparison. Both branches are needed:
// the first catches later timestamps, the second catches same-timestamp
// rows with a larger id (which the plain `>` would drop).

import type { PrismaClient, Role } from '@shadhil/database';
import { Prisma, withRlsContext } from '@shadhil/database';
import { notificationTypesHiddenFrom } from '@shadhil/api-types';

import type { CursorFrame, StreamCursor } from './cursor.js';
import { START_OF_STREAM } from './cursor.js';

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
export async function resolveUserContext(prisma: PrismaClient, userId: string): Promise<SseUser> {
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

/**
 * The `(createdAt, id) > (cursor.createdAt, cursor.id)` predicate.
 *
 * Shared so all four channels page consistently - a channel that forgot the
 * tie-breaker branch would silently drop same-timestamp rows, which is the
 * exact bug this file was changed to fix.
 */
function afterCursor(cursor: StreamCursor): {
  OR: [{ createdAt: { gt: Date } }, { createdAt: Date; id: { gt: string } }];
} {
  return {
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      // Same timestamp, higher id. `gte` on the date plus `gt` on the id is
      // equivalent and avoids relying on exact microsecond equality - but
      // `equals` (the default) is what Prisma generates here and matches the
      // documented tuple semantics, so keep it explicit.
      { createdAt: cursor.createdAt, id: { gt: cursor.id } },
    ],
  };
}

/**
 * Ordering that matches `afterCursor`. Without this the batch may come back
 * in an order that disagrees with the cursor, and the window between pages
 * becomes undefined (rows could be skipped or re-sent).
 */
const CURSOR_ORDER = [{ createdAt: 'asc' }, { id: 'asc' }] as const;

/** Notifications fetcher - emits one frame per row.
 *
 * 2026-11-21: admin-only types are excluded for non-admin viewers. The SSE
 * stream builds its own `where` (it never goes through NotificationsService), so
 * this is the second place the rule has to be applied - without it a demoted
 * ADMIN keeps receiving `feedback.created` frames that link to a page that 403s
 * for them. Same helper as the REST list and the badge count, so the three read
 * paths cannot disagree. */
export const notificationsFetcher =
  (prisma: PrismaClient, user: SseUser) =>
  async (cursor: StreamCursor): Promise<CursorFrame[]> => {
    const hiddenTypes = notificationTypesHiddenFrom(user.role);
    const rows = await withRlsContext(
      prisma,
      { userId: user.userId, role: user.role, organizationId: user.organizationId },
      async (tx) =>
        tx.notification.findMany({
          where: {
            userId: user.userId,
            ...(hiddenTypes !== null ? { NOT: { type: { in: hiddenTypes } } } : {}),
            ...afterCursor(cursor),
          },
          orderBy: [...CURSOR_ORDER],
          take: FETCH_BATCH,
        }),
    );
    return rows.map((n) => ({
      id: n.id,
      cursor: { createdAt: n.createdAt, id: n.id },
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
  async (cursor: StreamCursor): Promise<CursorFrame[]> => {
    const seeAll = user.role === 'ADMIN' || user.role === 'OWNER';
    const rows = await withRlsContext(
      prisma,
      { userId: user.userId, role: user.role, organizationId: user.organizationId },
      async (tx) =>
        tx.auditLog.findMany({
          where: {
            ...afterCursor(cursor),
            ...(seeAll ? {} : { userId: user.userId }),
          },
          orderBy: [...CURSOR_ORDER],
          take: FETCH_BATCH,
        }),
    );
    return rows.map((a) => ({
      id: a.id,
      cursor: { createdAt: a.createdAt, id: a.id },
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
  async (cursor: StreamCursor): Promise<CursorFrame[]> => {
    const rows = await withRlsContext(
      prisma,
      { userId: user.userId, role: user.role, organizationId: user.organizationId },
      async (tx) =>
        tx.message.findMany({
          where: { leadId, ...afterCursor(cursor) },
          orderBy: [...CURSOR_ORDER],
          take: FETCH_BATCH,
        }),
    );
    return rows.map((m) => ({
      id: m.id,
      cursor: { createdAt: m.createdAt, id: m.id },
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

/**
 * Contact-thread chat fetcher - same contract as `chatFetcher`, keyed on
 * `contactId` instead of `leadId` (a Message belongs to exactly one thread).
 *
 * Visibility comes from `message_select_contact`, which gates on the
 * ADMIN/OWNER/MANAGER role plus the org, and re-checks the parent contact's
 * org (including the intentionally-nullable org-less case). Running inside
 * withRlsContext is what makes that policy apply - a bare findMany would be
 * filtered to zero rows and the stream would look connected but silent.
 */
export const contactChatFetcher =
  (prisma: PrismaClient, user: SseUser, contactId: string) =>
  async (cursor: StreamCursor): Promise<CursorFrame[]> => {
    const rows = await withRlsContext(
      prisma,
      { userId: user.userId, role: user.role, organizationId: user.organizationId },
      async (tx) =>
        tx.message.findMany({
          where: { contactId, ...afterCursor(cursor) },
          orderBy: [...CURSOR_ORDER],
          take: FETCH_BATCH,
        }),
    );
    return rows.map((m) => ({
      id: m.id,
      cursor: { createdAt: m.createdAt, id: m.id },
      data: {
        id: m.id,
        contactId: m.contactId,
        direction: m.direction,
        channel: m.channel,
        body: m.body,
        mediaUrl: m.mediaUrl,
        createdAt: m.createdAt.toISOString(),
      },
    }));
  };

/**
 * Resolve the cursor to resume a reconnecting client from.
 *
 * A Last-Event-ID names the last row the CLIENT saw, so we look up that row's
 * (createdAt, id) and continue strictly after it - no gap, no repeat.
 *
 * `extraWhere` pins the lookup to the channel's thread, so a forged or stale
 * id from another thread cannot pull this stream forward (which would skip
 * rows). If the row is gone (pruned/older than the lookup) we fall back to the
 * start of stream: re-sending is recoverable by the client's cache, whereas
 * skipping is not.
 *
 * NOTE the deliberate absence of `new Date()` anywhere in this file. The
 * previous implementation anchored on the wall clock, which is what lost rows.
 */
export async function cursorForLastEvent(
  prisma: PrismaClient,
  model: 'Notification' | 'AuditLog' | 'Message',
  lastEventId: string | null,
  extraWhere?: Record<string, string>,
): Promise<StreamCursor> {
  if (lastEventId === null) return START_OF_STREAM;

  const where = extraWhere !== undefined ? { id: lastEventId, ...extraWhere } : { id: lastEventId };

  // Typed access per model rather than a string-keyed Record cast: Prisma's
  // query types are per-delegate, and a cast is how the wrong column name
  // (e.g. `leadId` on a Notification) would slip through unnoticed.
  const found = await (async (): Promise<{ createdAt: Date; id: string } | null> => {
    switch (model) {
      case 'Notification':
        return prisma.notification.findFirst({
          where,
          select: { createdAt: true, id: true },
        });
      case 'AuditLog':
        return prisma.auditLog.findFirst({
          where,
          select: { createdAt: true, id: true },
        });
      case 'Message':
        return prisma.message.findFirst({
          where,
          select: { createdAt: true, id: true },
        });
    }
  })();

  if (found === null) return START_OF_STREAM;
  return { createdAt: found.createdAt, id: found.id };
}

// Re-exported so callers do not need a second import for the tuple type.
export type { CursorFrame, StreamCursor };

// `Prisma` is imported for the generated delegate types above; keep the
// reference explicit so the import is not dropped by a future refactor.
export type NotificationWhereInput = Prisma.NotificationWhereInput;
