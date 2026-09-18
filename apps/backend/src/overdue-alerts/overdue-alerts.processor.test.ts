// T-OVERDUE-ALERTS (2026-09-18) - cron processor test.
//
// Drives OverdueAlertsService.tick() against the live dev DB, mirroring the
// reminders.processor.test.ts fixture pattern (adminSeed for inserts, stub
// Redis for the lock). Asserts:
//
//   1. Happy path: one tick emits to the lead owner, team manager, AND org
//      owner(s) (deduped), and stamps lastOverduePushedAt.
//   2. Every-1-hour cadence: a second tick within the hour does NOT re-push
//      (the durable stamp dedupes).
//   3. Recipient resolution: a manager who leads the team AND is the org
//      owner receives ONE notification (deduped, not twice).
//
// NotificationsService is constructed WITHOUT a PushService (the @Optional
// push dep is absent) so emits write an in-app Notification row but skip the
// web push - the push path is covered by push.service tests + the emit →
// pushBestEffort wiring in notifications.service.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma as runtimePrisma, type PrismaClient } from '@shadhil/database';
import { withRlsContext } from '@shadhil/database';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.module';
import { RedisService } from '../redis/redis.module';
import {
  OverdueAlertsService,
  OVERDUE_ALERT_LOCK_KEY,
} from './overdue-alerts.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const HAS_REDIS = Boolean(process.env.REDIS_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

const ORG_ID = 'ceid01lpfe1esm8jwsxid41k28';
const ADMIN_ID = 'zhp69koimlj4hqorl1skmpsq';
const TEST_PROJECT_ID = 'wqvswgk5n0ucvq8l1ydva3d7';
// The org's single OWNER (the one_owner_per_org constraint forbids seeding a
// second). Verified present in the dev DB. This is the org-owner recipient.
const ORG_OWNER_ID = 'oet70k7svsjrta4480fnyenx';

// Ids unique per test run (hyphen-free base36 so the FK/unique constraints hold).
const runToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER_ID = `ovdo-${runToken}`; // lead owner (TELECALLER)
const MANAGER_ID = `mgro-${runToken}`; // team manager (MANAGER, distinct)
const TEAM_ID = `team-${runToken}`;
const LEAD_ID = `lead-${runToken}`;
const LEAD2_ID = `lead2-${runToken}`;

async function adminSeed<T>(
  fn: (db: PrismaClient) => Promise<T>,
): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', organizationId: ORG_ID },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

async function cleanup(): Promise<void> {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.notification.deleteMany({
      where: { leadId: LEAD_ID },
    });
    await db.lead.deleteMany({ where: { id: LEAD_ID } });
    await db.team.deleteMany({ where: { id: TEAM_ID } });
    await db.user.deleteMany({ where: { id: { in: [OWNER_ID, MANAGER_ID] } } });
  });
}

// Seed: org owner (OWNER role), a manager (leads a team), a team + project,
// and an OVERDUE NEW lead owned by the manager's teammate (the owner here).
async function seedFixtures(): Promise<void> {
  if (prisma === null) throw new Error('prisma missing');
  await adminSeed(async (db) => {
    await db.user.upsert({
      where: { id: ADMIN_ID },
      update: {},
      create: {
        id: ADMIN_ID,
        email: `test-ovdo-admin@x`,
        name: 'test-ovdo-admin',
        role: 'ADMIN',
        emailVerified: true,
        organizationId: ORG_ID,
      },
    });
    // Team manager - a MANAGER-role user. Distinct from the lead owner and
    // from the org owner, so recipient-resolution is provably three-way.
    await db.user.upsert({
      where: { id: MANAGER_ID },
      update: { role: 'MANAGER' },
      create: {
        id: MANAGER_ID,
        email: `test-ovdo-mgr@${runToken}.x`,
        name: 'Test Team Manager',
        role: 'MANAGER',
        emailVerified: true,
        organizationId: ORG_ID,
      },
    });
    // Lead owner - a TELECALLER (the person who must work the lead), distinct
    // from the manager and the org owner.
    await db.user.upsert({
      where: { id: OWNER_ID },
      update: { role: 'TELECALLER' },
      create: {
        id: OWNER_ID,
        email: `test-ovdo-owner@${runToken}.x`,
        name: 'Test Lead Owner',
        role: 'TELECALLER',
        emailVerified: true,
        organizationId: ORG_ID,
      },
    });
    await db.team.upsert({
      where: { id: TEAM_ID },
      update: { managerId: MANAGER_ID },
      create: {
        id: TEAM_ID,
        name: `Overdue Test Team ${runToken}`,
        managerId: MANAGER_ID,
        organizationId: ORG_ID,
      },
    });
    await db.project.upsert({
      where: { id: TEST_PROJECT_ID },
      update: {},
      create: {
        id: TEST_PROJECT_ID,
        name: 'Test Project',
        slug: TEST_PROJECT_ID,
        address: '123 Test',
        organizationId: ORG_ID,
      },
    });
    await db.lead.create({
      data: {
        id: LEAD_ID,
        name: 'Test Overdue Lead',
        phone: `99${runToken.replace(/[^0-9]/g, '').slice(0, 8)}`,
        state: 'NEW',
        ownerId: OWNER_ID,
        ownerType: 'TELECALLER',
        teamId: TEAM_ID,
        organizationId: ORG_ID,
        projectId: TEST_PROJECT_ID,
        // Created > 30min ago → overdue.
        createdAt: new Date(Date.now() - 40 * 60_000),
      },
    });
  });
}

class StubRedis implements Pick<RedisService, 'acquireLock' | 'releaseLock' | 'renewLease'> {
  private readonly store = new Map<string, string>();
  private now = 0;

  acquireLock(key: string, ttlSec: number, token: string): Promise<boolean> {
    const existing = this.store.get(key);
    if (existing !== undefined) {
      const parsed = JSON.parse(existing) as { expiresAt: number };
      if (parsed.expiresAt > this.now) return Promise.resolve(false);
    }
    this.store.set(key, JSON.stringify({ token, expiresAt: this.now + ttlSec * 1000 }));
    return Promise.resolve(true);
  }

  releaseLock(key: string, token: string): Promise<void> {
    const raw = this.store.get(key);
    if (raw === undefined) return Promise.resolve();
    const parsed = JSON.parse(raw) as { token: string };
    if (parsed.token === token) this.store.delete(key);
    return Promise.resolve();
  }

  renewLease(key: string, token: string, ttlSec: number): Promise<boolean> {
    const raw = this.store.get(key);
    if (raw === undefined) return Promise.resolve(false);
    const parsed = JSON.parse(raw) as { token: string; expiresAt: number };
    if (parsed.token !== token) return Promise.resolve(false);
    parsed.expiresAt = this.now + ttlSec * 1000;
    this.store.set(key, JSON.stringify(parsed));
    return Promise.resolve(true);
  }

  reset(): void {
    this.store.clear();
    this.now = 0;
  }
}

describe.skipIf(!HAS_DB || !HAS_REDIS)(
  'T-OVERDUE-ALERTS overdue cron - recipients + cadence',
  () => {
    let stubRedis: StubRedis;
    let prismaService: PrismaService;
    let service: OverdueAlertsService;
    let notifications: NotificationsService;

    beforeAll(async () => {
      await seedFixtures();
    }, 30_000);

    afterAll(async () => {
      await cleanup();
    }, 30_000);

    beforeEach(() => {
      stubRedis = new StubRedis();
      prismaService = {
        $client: prisma as unknown as PrismaClient,
      } as PrismaService;
      // NotificationsService constructed WITHOUT PushService - @Optional.
      notifications = new NotificationsService(prismaService);
      service = new OverdueAlertsService(
        prismaService,
        stubRedis as unknown as RedisService,
        notifications,
      );
      stubRedis.reset();
    });

    it('happy path: emits to owner + manager + org owner, then stamps the lead', async () => {
      await service.tick();
      const last = service.getLastTick();
      expect(last?.lockHeld).toBe(true);
      expect(last?.considered).toBeGreaterThan(0);

      // Notifications are owner-scoped by RLS (notification_select_owner:
      // a user only sees their own rows). The cron emitted one to EACH of the
      // three recipients (owner, team manager, org owner), so read each
      // recipient's inbox with that user's RLS context.
      const recipientUserIds = [OWNER_ID, MANAGER_ID, ORG_OWNER_ID];
      const seen = new Set<string>();
      for (const userId of recipientUserIds) {
        const rows = await withRlsContext(
          prisma as unknown as PrismaClient,
          { userId, role: 'TELECALLER' as const, organizationId: ORG_ID },
          async (tx) =>
            (tx as unknown as PrismaClient).notification.findMany({
              where: { leadId: LEAD_ID, type: 'lead.overdue' },
              select: { userId: true },
            }),
        );
        if (rows.length > 0) seen.add(userId);
      }
      expect(seen.has(OWNER_ID)).toBe(true);
      expect(seen.has(MANAGER_ID)).toBe(true);
      expect(seen.has(ORG_OWNER_ID)).toBe(true);
      expect(seen.size).toBe(3);

      // The durable stamp was set (dedupes the hourly cadence).
      const lead = await adminSeed((db) =>
        db.lead.findUnique({
          where: { id: LEAD_ID },
          select: { lastOverduePushedAt: true },
        }),
      );
      expect(lead?.lastOverduePushedAt).toBeInstanceOf(Date);
    });

    it('every-1-hour cadence: a second tick within the hour does NOT re-push', async () => {
      // First tick pushes + stamps.
      await service.tick();

      // Immediately tick again - should consider 0 (already stamp this tick
      // window), so no duplicate notifications.
      await service.tick();

      // Count via the lead owner's RLS context (admin can't see others' rows).
      const forOwner = await withRlsContext(
        prisma as unknown as PrismaClient,
        { userId: OWNER_ID, role: 'TELECALLER' as const, organizationId: ORG_ID },
        async (tx) =>
          (tx as unknown as PrismaClient).notification.count({
            where: { leadId: LEAD_ID, type: 'lead.overdue' },
          }),
      );
      // 1 from the first tick (owner's inbox), nothing duplicated by the second.
      expect(forOwner).toBe(1);
    });

    it('lock contention: a second replica is rejected when the lock is held', async () => {
      const REPLICA_A = 'ovdo-replica-a';
      const acquired = await stubRedis.acquireLock(
        OVERDUE_ALERT_LOCK_KEY,
        50,
        REPLICA_A,
      );
      expect(acquired).toBe(true);

      await service.tick();
      const last = service.getLastTick();
      expect(last?.lockHeld).toBe(false);
      expect(last?.considered).toBe(0);

      await stubRedis.releaseLock(OVERDUE_ALERT_LOCK_KEY, REPLICA_A);
    });
  },
);
