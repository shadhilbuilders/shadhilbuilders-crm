// Admin-only notifications are excluded from the SSE stream (2026-11-21).
//
// WHY THIS SUITE EXISTS SEPARATELY from the backend's admin-only-visibility
// tests: the stream service builds its OWN Prisma `where` (it never calls
// NotificationsService.list), so a gate added only to the REST list would leave
// a demoted ADMIN receiving `feedback.created` frames over SSE - the bell badge
// and inbox would look clean while live rows still arrived.
//
// Same helper (`notificationTypesHiddenFrom`) as the REST list and badge count,
// so the three read paths cannot drift apart.
import { describe, expect, it, vi } from 'vitest';

import { START_OF_STREAM, type StreamCursor } from './cursor.js';
import { notificationsFetcher, type SseUser } from './fetchers.js';

const CURSOR: StreamCursor = { createdAt: new Date('2026-11-21T10:00:00.000Z'), id: 'c0005' };

function user(role: SseUser['role']): SseUser {
  return { userId: 'user-1', role, organizationId: 'org-1' };
}

/** PrismaClient stand-in: withRlsContext issues SET LOCAL via $executeRawUnsafe. */
function fakePrisma(): {
  client: Parameters<typeof notificationsFetcher>[0];
  findMany: ReturnType<typeof vi.fn>;
} {
  const findMany = vi.fn(async () => []);
  const delegates = { notification: { findMany } };
  const client = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $executeRawUnsafe: async () => 0, ...delegates }),
    ...delegates,
  };
  return { client: client as unknown as Parameters<typeof notificationsFetcher>[0], findMany };
}

const whereOf = (findMany: ReturnType<typeof vi.fn>): Record<string, unknown> =>
  findMany.mock.calls[0]![0].where as Record<string, unknown>;

describe('notificationsFetcher - admin-only exclusion', () => {
  it('protects= a non-admin stream excludes feedback notifications', async () => {
    for (const role of ['MANAGER', 'TELECALLER', 'SALES_EXEC', 'ENGINEER'] as const) {
      const { client, findMany } = fakePrisma();
      await notificationsFetcher(client, user(role))(CURSOR);
      expect(whereOf(findMany), `${role} must not stream admin-only rows`).toMatchObject({
        NOT: { type: { in: ['feedback.created'] } },
      });
    }
  });

  it('protects= ADMIN and OWNER streams carry no exclusion clause', async () => {
    for (const role of ['ADMIN', 'OWNER'] as const) {
      const { client, findMany } = fakePrisma();
      await notificationsFetcher(client, user(role))(CURSOR);
      expect(whereOf(findMany), `${role} must stream admin-only rows`).not.toHaveProperty('NOT');
    }
  });

  it('protects= the exclusion does not disturb the userId scope or the cursor', async () => {
    // The stream is per-recipient and must still page on the (createdAt, id)
    // tuple - the exclusion is an ADDITIONAL clause, never a replacement.
    const { client, findMany } = fakePrisma();
    await notificationsFetcher(client, user('TELECALLER'))(CURSOR);

    const where = whereOf(findMany);
    expect(where.userId).toBe('user-1');
    expect(where.NOT).toEqual({ type: { in: ['feedback.created'] } });
    expect(where.OR).toEqual([
      { createdAt: { gt: CURSOR.createdAt } },
      { createdAt: CURSOR.createdAt, id: { gt: CURSOR.id } },
    ]);
  });

  it('protects= a non-admin stream still starts from the beginning of the stream', async () => {
    // START_OF_STREAM is a concrete epoch cursor (not null), so the tuple
    // predicate is always present - this pins that the gate did not replace it
    // and that the first connect still reads from epoch.
    const { client, findMany } = fakePrisma();
    await notificationsFetcher(client, user('MANAGER'))(START_OF_STREAM);

    const where = whereOf(findMany);
    expect(where.userId).toBe('user-1');
    expect(where.NOT).toEqual({ type: { in: ['feedback.created'] } });
    expect(where.OR).toEqual([
      { createdAt: { gt: START_OF_STREAM.createdAt } },
      { createdAt: START_OF_STREAM.createdAt, id: { gt: START_OF_STREAM.id } },
    ]);
  });
});
