// T-E2 - StreamTicket lifecycle integration tests.
//
// Pins the contract RealtimeService.consumeTicket must hold:
//   1. A valid ticket is consumed once, returns {userId, channel},
//      and the row is deleted (single-use).
//   2. A replayed ticket (already consumed → row gone) is rejected
//      with ForbiddenException('invalid ticket').
//   3. An expired ticket is rejected with ForbiddenException('ticket
//      expired') and the row is auto-deleted (the reap-on-consume
//      path keeps the table from growing).
//   4. A wrong-channel ticket is rejected with ForbiddenException
//      ('ticket channel mismatch') and the row is NOT deleted
//      (so a legit caller connecting to the right channel still
//      succeeds).
//
// Real Prisma + real RLS. The bare shadhil_app role can read/write
// StreamTicket (it's an auth-adjacent table - see references/postgres-
// multi-role-grants.md). Fixture: a User row + a hand-inserted
// StreamTicket row.
//
// The plan's verify line is "integration test: expired/replayed
// ticket rejected" - this file is that test. The identical logic
// lives in apps/realtime-sse/src/stream.ts:consumeTicket (a port
// of the same shape for the standalone SSE service). Backend is
// the source of truth; testing it covers the contract.
import { ForbiddenException } from '@nestjs/common';
import {
  prisma as runtimePrisma,
  type PrismaClient,
  withRlsContext,
} from '@shadhil/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma/prisma.module';
import { RealtimeService } from './realtime.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

const TEST_USER_ID = 'test-realtime-ticket-user';
const TEST_TEAM_ID = 'test-realtime-ticket-team';
const TEST_TICKET_IDS: string[] = [];

async function adminSeed<T>(
  fn: (db: PrismaClient) => Promise<T>,
): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    {
      userId: TEST_USER_ID,
      role: 'ADMIN',
      teamId: TEST_TEAM_ID,
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

async function ensureUser(): Promise<void> {
  await adminSeed(async (db) => {
    // Team FK first (User.teamId).
    await db.team.upsert({
      where: { id: TEST_TEAM_ID },
      update: {},
      create: { id: TEST_TEAM_ID, name: 'Realtime Ticket Test Team', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
    });
    await db.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: {
        id: TEST_USER_ID,
        email: 'realtime-ticket@test.local',
        name: 'Realtime Ticket Test',
        role: 'ADMIN',
        teamId: TEST_TEAM_ID,
        organizationId: 'ceid01lpfe1esm8jwsxid41k28',
      },
    });
  });
}

async function seedTicket(opts: {
  channel: string;
  expiresAt: Date;
}): Promise<string> {
  if (prisma === null) throw new Error('prisma missing');
  const id = `test-tkt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await adminSeed(async (db) => {
    await db.streamTicket.create({
      data: {
        id,
        userId: TEST_USER_ID,
        channel: opts.channel,
        expiresAt: opts.expiresAt,
        organizationId: 'ceid01lpfe1esm8jwsxid41k28',
      },
    });
  });
  TEST_TICKET_IDS.push(id);
  return id;
}

async function cleanupTestTickets(): Promise<void> {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    if (TEST_TICKET_IDS.length > 0) {
      await db.streamTicket.deleteMany({
        where: { id: { in: TEST_TICKET_IDS } },
      });
    }
  });
  TEST_TICKET_IDS.length = 0;
}

async function ticketExists(id: string): Promise<boolean> {
  if (prisma === null) return false;
  const row = await adminSeed(async (db) =>
    db.streamTicket.findUnique({ where: { id }, select: { id: true } }),
  );
  return row !== null;
}

describe.skipIf(!HAS_DB)('T-E2 StreamTicket - consumeTicket lifecycle', () => {
  let prismaService: PrismaService;
  let service: RealtimeService;

  beforeAll(async () => {
    await ensureUser();
  }, 30_000);

  afterAll(async () => {
    await cleanupTestTickets();
  }, 30_000);

  beforeEach(() => {
    prismaService = {
      $client: prisma as unknown as PrismaClient,
    } as PrismaService;
    service = new RealtimeService(prismaService);
  });

  it('consumes a valid ticket: returns {userId, channel} and deletes the row (single-use)', async () => {
    const id = await seedTicket({
      channel: 'notifications',
      expiresAt: new Date(Date.now() + 60_000), // 1 min in the future
    });

    const result = await service.consumeTicket(id, 'notifications');

    expect(result.userId).toBe(TEST_USER_ID);
    expect(result.channel).toBe('notifications');
    // Single-use: row is deleted before return.
    expect(await ticketExists(id)).toBe(false);
  });

  it('rejects a replayed ticket: second consumeTicket call sees the row already gone', async () => {
    const id = await seedTicket({
      channel: 'notifications',
      expiresAt: new Date(Date.now() + 60_000),
    });

    // First consume succeeds.
    await service.consumeTicket(id, 'notifications');

    // Second consume with the SAME ticket id - the row is gone.
    await expect(
      service.consumeTicket(id, 'notifications'),
    ).rejects.toThrow(ForbiddenException);

    // Reject message must mention 'invalid ticket' (not 'expired'
    // or 'channel mismatch' - we want to verify the *replay* path,
    // not the expiry path, fires here).
    let thrown: unknown;
    try {
      await service.consumeTicket(id, 'notifications');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).message).toBe('invalid ticket');
  });

  it('rejects an expired ticket and auto-deletes the row (reap-on-consume)', async () => {
    // Expired 1 hour ago - well past the 5-minute TTL.
    const id = await seedTicket({
      channel: 'notifications',
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // The first call must throw 'ticket expired' (not 'invalid ticket').
    // We catch the exception directly because the second call would
    // see the row already gone (the reap-on-consume path deletes the
    // expired row before throwing) and throw 'invalid ticket' instead,
    // which would hide the contract we want to pin here.
    let thrown: unknown;
    try {
      await service.consumeTicket(id, 'notifications');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).message).toBe('ticket expired');

    // The expired row is auto-deleted by the consume path so the
    // table doesn't grow. The reap cron (every minute) catches
    // truly orphaned rows, but the consume path is the first line.
    expect(await ticketExists(id)).toBe(false);
  });

  it('rejects a wrong-channel ticket and leaves the row intact (the right channel can still consume)', async () => {
    const id = await seedTicket({
      channel: 'chat:lead-abc',
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Trying to consume against the wrong channel must reject.
    let thrown: unknown;
    try {
      await service.consumeTicket(id, 'notifications');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).message).toBe(
      'ticket channel mismatch',
    );

    // The row is NOT deleted on a mismatch - the legitimate caller
    // (on the right channel) can still connect.
    expect(await ticketExists(id)).toBe(true);

    // And the right channel can still consume it.
    const result = await service.consumeTicket(id, 'chat:lead-abc');
    expect(result.channel).toBe('chat:lead-abc');
    expect(result.userId).toBe(TEST_USER_ID);
    expect(await ticketExists(id)).toBe(false);
  });
});
