// Fetcher query contract - T-SSE-ANCHOR (2026-11-21).
//
// The cursor fix in the loop is only correct if the queries agree with it:
//   1. the WHERE must be the (createdAt, id) tuple comparison, not a bare
//      `createdAt >` - otherwise same-timestamp rows are dropped;
//   2. the ORDER BY must be [createdAt, id] - otherwise the window between
//      pages is undefined and the cursor can advance past unseen rows.
//
// These assert the arguments each fetcher actually hands Prisma. They use a
// fake client rather than a live DB: the contract under test is the query
// SHAPE (which is what regressed), and a fake keeps this suite runnable
// without Postgres provisioning.
import { describe, expect, it, vi } from 'vitest';

import { START_OF_STREAM, type StreamCursor } from './cursor.js';
import {
  auditFetcher,
  chatFetcher,
  contactChatFetcher,
  cursorForLastEvent,
  notificationsFetcher,
  type SseUser,
} from './fetchers.js';

const USER: SseUser = {
  userId: 'user-1',
  role: 'MANAGER',
  organizationId: 'org-1',
};

const CURSOR: StreamCursor = { createdAt: new Date('2026-11-21T10:00:00.000Z'), id: 'c0005' };

/**
 * A PrismaClient stand-in. `withRlsContext` calls `$transaction` and issues
 * three SET LOCAL statements, so `$executeRawUnsafe` must exist as a no-op.
 */
function fakePrisma(rows: unknown[] = []): {
  client: Parameters<typeof chatFetcher>[0];
  findMany: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
} {
  const findMany = vi.fn(async () => rows);
  const findFirst = vi.fn(async () => null);

  const delegates = {
    notification: { findMany, findFirst },
    auditLog: { findMany, findFirst },
    message: { findMany, findFirst },
  };

  const client = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $executeRawUnsafe: async () => 0, ...delegates }),
    ...delegates,
  };

  return { client: client as unknown as Parameters<typeof chatFetcher>[0], findMany, findFirst };
}

/** The single findMany argument the fetcher under test produced. */
function argsOf(findMany: ReturnType<typeof vi.fn>): {
  where: Record<string, unknown>;
  orderBy: unknown;
  take: number;
} {
  expect(findMany).toHaveBeenCalledTimes(1);
  return findMany.mock.calls[0]![0] as {
    where: Record<string, unknown>;
    orderBy: unknown;
    take: number;
  };
}

/**
 * Assert the WHERE expresses `(createdAt, id) > cursor`.
 * Prisma cannot do row-value comparison, so the fetcher emits OR with a
 * tie-breaker branch; both halves must be present.
 */
function expectTupleCursor(where: Record<string, unknown>, cursor: StreamCursor): void {
  const or = where.OR as Array<Record<string, unknown>> | undefined;
  expect(Array.isArray(or)).toBe(true);
  expect(or).toHaveLength(2);

  // Branch 1: strictly later timestamp.
  expect(or![0]).toEqual({ createdAt: { gt: cursor.createdAt } });

  // Branch 2: same timestamp, greater id (the tie-breaker). Without this,
  // rows sharing a createdAt are skipped forever.
  expect(or![1]).toEqual({ createdAt: cursor.createdAt, id: { gt: cursor.id } });
}

const EXPECTED_ORDER = [{ createdAt: 'asc' }, { id: 'asc' }];

describe('every chat fetcher pages on the (createdAt, id) tuple', () => {
  it('notifications', async () => {
    const { client, findMany } = fakePrisma();
    await notificationsFetcher(client, USER)(CURSOR);

    const args = argsOf(findMany);
    expectTupleCursor(args.where, CURSOR);
    expect(args.orderBy).toEqual(EXPECTED_ORDER);
  });

  it('audit', async () => {
    const { client, findMany } = fakePrisma();
    await auditFetcher(client, USER)(CURSOR);

    const args = argsOf(findMany);
    expectTupleCursor(args.where, CURSOR);
    expect(args.orderBy).toEqual(EXPECTED_ORDER);
  });

  it('lead chat', async () => {
    const { client, findMany } = fakePrisma();
    await chatFetcher(client, USER, 'lead-1')(CURSOR);

    const args = argsOf(findMany);
    expectTupleCursor(args.where, CURSOR);
    expect(args.orderBy).toEqual(EXPECTED_ORDER);
    expect(args.where.leadId).toBe('lead-1');
  });

  it('contact chat', async () => {
    const { client, findMany } = fakePrisma();
    await contactChatFetcher(client, USER, 'contact-1')(CURSOR);

    const args = argsOf(findMany);
    expectTupleCursor(args.where, CURSOR);
    expect(args.orderBy).toEqual(EXPECTED_ORDER);
    expect(args.where.contactId).toBe('contact-1');
  });

  it("keeps the channel's own scoping alongside the cursor", async () => {
    // The cursor predicate must be ANDed with the channel's filter, never
    // replace it - otherwise a contact stream would read every thread.
    const { client, findMany } = fakePrisma();
    await contactChatFetcher(client, USER, 'contact-1')(CURSOR);

    const { where } = argsOf(findMany);
    expect(where).toMatchObject({ contactId: 'contact-1' });
    expect(where.OR).toBeDefined();
  });
});

describe('fetchers emit cursors the loop can advance', () => {
  it('attaches a (createdAt, id) cursor to every frame', async () => {
    const createdAt = new Date('2026-11-21T10:00:03.000Z');
    const { client } = fakePrisma([
      { id: 'msg-1', createdAt, direction: 'IN', channel: 'WHATSAPP', body: 'hi' },
    ]);

    const frames = await chatFetcher(client, USER, 'lead-1')(START_OF_STREAM);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBe('msg-1');
    // The loop advances on this; if a fetcher ever omits it the stream stalls
    // silently at the start cursor and re-sends forever.
    expect(frames[0]!.cursor).toEqual({ createdAt, id: 'msg-1' });
  });
});

describe('cursorForLastEvent - resume position', () => {
  it('starts at the beginning when there is no Last-Event-ID', async () => {
    const { client, findFirst } = fakePrisma();
    const cursor = await cursorForLastEvent(client, 'Message', null);

    expect(cursor).toEqual(START_OF_STREAM);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('resumes after the row named by Last-Event-ID', async () => {
    const createdAt = new Date('2026-11-21T09:59:00.000Z');
    const { client, findFirst } = fakePrisma();
    findFirst.mockResolvedValue({ createdAt, id: 'msg-9' });

    const cursor = await cursorForLastEvent(client, 'Message', 'msg-9');

    expect(cursor).toEqual({ createdAt, id: 'msg-9' });
  });

  it('falls back to the start when the row is gone (re-send beats skip)', async () => {
    const { client } = fakePrisma();
    const cursor = await cursorForLastEvent(client, 'Message', 'pruned-row');

    // Duplicates are recoverable (the client cache dedupes); a gap is not.
    expect(cursor).toEqual(START_OF_STREAM);
  });

  it('pins the lookup to the channel thread', async () => {
    const { client, findFirst } = fakePrisma();
    await cursorForLastEvent(client, 'Message', 'msg-9', { contactId: 'contact-1' });

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0]![0]).toMatchObject({
      where: { id: 'msg-9', contactId: 'contact-1' },
    });
  });
});
