// T-G4 unit test - cron processor with Redis lock + status-claim.
//
// The Plan §18 verify line: "processor test: tick > 60s does not
// double-fire." This file drives the assertions via three scenarios:
//
//   1. Happy path: a single tick claims and "sends" N due reminders.
//   2. Lock contention: a second tick while another replica holds
//      the lock does no work (lockHeld = false, claimed = 0).
//   3. The killer test - tick > 60s does not double-fire: simulate a
//      batch that takes longer than the original lock TTL by holding
//      the lock past 50s; a SECOND replica that acquires the lock
//      after expiry must see zero due rows (status-claim catches the
//      race). Without the PROCESSING intermediate state, the second
//      replica would re-claim and re-deliver - duplicate fire.
//
// T-CRONS (2026-09-07): the cron's updateMany now runs inside
// withRlsContext as role=CRON_SERVICE so the reminder_cron_service
// RLS policy matches. The cron's DB writes no longer rely on a
// manual claim via adminSeed (happy path #1); they go through the
// service-account bypass. The lease-expiry scenario (#3) still
// uses adminSeed for the manual replica-A claim to keep the test
// independent of policy timing. See
// packages/database/prisma/migrations/20260907090000_reminder_cron_service_policy/
// and known-runtime-bugs.md Bug 8.
//
// We don't actually wait 60s in tests - the lease-renewal script
// is exercised indirectly via the duplicate-fire scenario, which
// covers the same code path. A live integration test (not in this
// file) would mock the timer.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma as runtimePrisma, type PrismaClient } from '@shadhil/database';
import { withRlsContext } from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';
import { RedisService } from '../redis/redis.module';
import { RemindersService, REMINDER_LOCK_KEY } from './reminders.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const HAS_REDIS = Boolean(process.env.REDIS_URL);

// Runtime client (RLS-enforced, shadhil_app role). The cron's
// updateMany / findMany go through withRlsContext as role=CRON_SERVICE
// (see reminders.service.ts:tick) so the reminder_cron_service policy
// matches - the cron's DB writes are no longer wrapped in adminSeed.
// adminSeed is still used in this test file for the LEASt scenario's
// manual replica-A claim (test #3), which seeds state independently
// of the cron service code path.
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

// Admin context wrapper for fixture seeding. shadhil_app is RLS-enforced
// (no BYPASSRLS - the original attempt in T-G4 was reverted because
// it broke the 128-case matrix). Seeding needs to insert
// Lead/Reminder/etc - admin satisfies every policy by role alone,
// BUT the Lead INSERT policy also checks teamId = app.user_team_id,
// so the admin context must set teamId to match the fixture's
// teamId. The reminder INSERT policy gates on userId = app.user_id,
// so the seeded reminder's userId matches the admin actor's userId.
async function adminSeed<T>(
  fn: (db: PrismaClient) => Promise<T>,
): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    {
      userId: 'zhp69koimlj4hqorl1skmpsq',
      role: 'ADMIN',
      teamId: 'yxt9evh7y5x9pkpxl61ywbyl',
      organizationId: 'org_bootstrap',
    },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

// Test fixtures: we need a SCHEDULED reminder that's due, so the
// cron's updateMany finds it. We seed one per test and clean up after.
const TEST_REMINDER_IDS: string[] = [];

async function seedDueReminder(label: string): Promise<string> {
  if (prisma === null) throw new Error('prisma missing');
  // We need a lead + user for the FK. We use adminSeed so the
  // fixture inserts go through the admin policy bypass.
  // Hyphen-free base36 id (satisfies z.cuid2()'s [0-9a-z]+ regex, unique per test).
  const id = `${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await adminSeed(async (db) => {
    // Ensure the admin actor's user row exists (FK target for the
    // reminder's userId below).
    await db.user.upsert({
      where: { id: 'zhp69koimlj4hqorl1skmpsq' },
      update: {},
      create: {
        id: 'zhp69koimlj4hqorl1skmpsq',
        email: 'test-reminder-admin@x',
        name: 'test-reminder-admin',
        role: 'ADMIN',
        emailVerified: true,
        organizationId: 'org_bootstrap',
      },
    });
    await db.user.upsert({
      where: { id: 'dyamh3gezek1ag5wh8xn9ib5' },
      update: {},
      create: {
        id: 'dyamh3gezek1ag5wh8xn9ib5',
        email: 'test-reminder-manager@x',
        name: 'test-reminder-manager',
        role: 'MANAGER',
        emailVerified: true,
        organizationId: 'org_bootstrap',
      },
    });
    await db.team.upsert({
      where: { id: 'yxt9evh7y5x9pkpxl61ywbyl' },
      update: {},
      create: { id: 'yxt9evh7y5x9pkpxl61ywbyl', name: 'Test Team', managerId: 'dyamh3gezek1ag5wh8xn9ib5', organizationId: 'org_bootstrap' },
    });
    const project = await db.project.upsert({
      where: { id: 'wqvswgk5n0ucvq8l1ydva3d7' },
      update: {},
      create: {
        id: 'wqvswgk5n0ucvq8l1ydva3d7',
        name: 'Test Project',
        slug: 'wqvswgk5n0ucvq8l1ydva3d7',
        address: '123 Test',
        organizationId: 'org_bootstrap',
      },
    });
    const phase = await db.phase.upsert({
      where: { id: 'otvkiihv4ai322i63rhfek4z' },
      update: {},
      create: { id: 'otvkiihv4ai322i63rhfek4z', projectId: project.id, name: 'Test Phase', organizationId: 'org_bootstrap' },
    });
    await db.unit.upsert({
      where: { phaseId_unitNumber: { phaseId: phase.id, unitNumber: 'T-001' } },
      update: {},
      create: {
        id: 'fm4z7bxv5z678ye32ek0zrns',
        phaseId: phase.id,
        unitNumber: 'T-001',
        bhk: 3,
        price: '10000000.00',
        organizationId: 'org_bootstrap',
      },
    });
    await db.lead.upsert({
      where: { id: 'qiurlpko8u0914y4k1eb8y3h' },
      update: {
        state: 'NEW',
        teamId: 'yxt9evh7y5x9pkpxl61ywbyl',
        ownerId: 'dyamh3gezek1ag5wh8xn9ib5',
        ownerType: 'MANAGER',
      },
      create: {
        id: 'qiurlpko8u0914y4k1eb8y3h',
        name: 'Test Reminder Lead',
        phone: '9900000099',
        state: 'NEW',
        teamId: 'yxt9evh7y5x9pkpxl61ywbyl',
        ownerId: 'dyamh3gezek1ag5wh8xn9ib5',
        ownerType: 'MANAGER',
        organizationId: 'org_bootstrap',
      },
    });
    await db.reminder.create({
      data: {
        id,
        leadId: 'qiurlpko8u0914y4k1eb8y3h',
        // Owner = the admin actor. The reminder_write_owner policy
        // is FOR ALL WITH CHECK userId = app.user_id; matching the
        // userId to the admin actor's id satisfies the WITH CHECK.
        // The cron's own claim will use claimedBy = replicaId, not
        // this userId, so this doesn't conflict with the production
        // ownership model.
        userId: 'zhp69koimlj4hqorl1skmpsq',
        type: 'PRE_VISIT_STAFF',
        status: 'SCHEDULED',
        scheduledFor: new Date(Date.now() - 60_000), // 1 minute ago - due
        organizationId: 'org_bootstrap',
      },
    });
  });
  TEST_REMINDER_IDS.push(id);
  return id;
}

async function cleanupTestReminders(): Promise<void> {
  if (prisma === null || TEST_REMINDER_IDS.length === 0) return;
  await adminSeed(async (db) => {
    await db.reminder.deleteMany({
      where: { id: { in: TEST_REMINDER_IDS } },
    });
  });
  TEST_REMINDER_IDS.length = 0;
}

class StubRedis implements Pick<RedisService, 'acquireLock' | 'releaseLock' | 'renewLease'> {
  private readonly store = new Map<string, string>();
  // Each acquire advances a monotonic clock; tests can advance it
  // by calling advanceTime(ms). Lock TTLs are tracked from the
  // acquire-time so renewal / expiry semantics are real.
  private now = 0;

  acquireLock(key: string, ttlSec: number, token: string): Promise<boolean> {
    // Lazy expiry check - Redis removes the key on access past
    // its TTL, not in a background sweeper. If the key is present
    // but expired, treat it as absent.
    const existing = this.store.get(key);
    if (existing !== undefined) {
      const parsed = JSON.parse(existing) as { expiresAt: number };
      if (parsed.expiresAt > this.now) {
        // Still valid → reject.
        return Promise.resolve(false);
      }
      // Expired - fall through and overwrite.
    }
    this.store.set(key, JSON.stringify({ token, expiresAt: this.now + ttlSec * 1000 }));
    return Promise.resolve(true);
  }

  releaseLock(key: string, token: string): Promise<void> {
    const raw = this.store.get(key);
    if (raw === undefined) return Promise.resolve();
    const parsed = JSON.parse(raw) as { token: string };
    if (parsed.token === token) {
      this.store.delete(key);
    }
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

  /** Test helper: advance the fake clock past a lock TTL. */
  advanceTime(ms: number): void {
    this.now += ms;
    // Expire any keys past their TTL - mimics Redis's lazy expiry.
    for (const [key, raw] of this.store.entries()) {
      const parsed = JSON.parse(raw) as { expiresAt: number };
      if (parsed.expiresAt <= this.now) {
        this.store.delete(key);
      }
    }
  }

  /** Test helper: clear all locks (between tests). */
  reset(): void {
    this.store.clear();
    this.now = 0;
  }
}

describe.skipIf(!HAS_DB || !HAS_REDIS)(
  'T-G4 reminder cron - lease + status-claim',
  () => {
    let stubRedis: StubRedis;
    let prismaService: PrismaService;
    let reminders: RemindersService;

    beforeAll(async () => {
      // Seed one due reminder that the happy-path tick can claim.
      await seedDueReminder('happy');
    }, 30_000);

    afterAll(async () => {
      await cleanupTestReminders();
    }, 30_000);

    beforeEach(() => {
      stubRedis = new StubRedis();
      prismaService = {
        $client: prisma as unknown as PrismaClient,
      } as PrismaService;
      // Construct with the stub redis. The RedisService type accepts
      // any object with the three methods we use.
      reminders = new RemindersService(prismaService, stubRedis as unknown as RedisService);
      stubRedis.reset();
    });

    it('happy path: tick claims + delivers the due reminder', async () => {
      const tickResult = await reminders.tick();
      expect(tickResult).toBeUndefined();
      const last = reminders.getLastTick();
      expect(last).not.toBeNull();
      expect(last?.lockHeld).toBe(true);
      // T-CRONS (2026-09-07): the reminder_cron_service RLS policy
      // lets the CRON_SERVICE actor claim any reminder row regardless
      // of owner, so updateMany(SCHEDULED → PROCESSING) now returns
      // >0. The claim count depends on the test fixture state, so we
      // assert >=1 (we seeded one due reminder in beforeAll). The
      // delivery adapter is still a no-op until Week 7, so `sent`
      // stays at 0.
      expect(last?.claimed).toBeGreaterThan(0);
      expect(last?.finishedAt).toBeInstanceOf(Date);
    });

    it('lock contention: a second replica is rejected when first holds the lock', async () => {
      // Manually grab the lock with replica-A's token BEFORE the
      // service tries to acquire - this simulates the case where
      // another replica is mid-tick. The service's tick() will then
      // fail to acquire and return cleanly with lockHeld=false.
      const REPLICA_A = 'replica-a-test';
      const acquired = await stubRedis.acquireLock(
        REMINDER_LOCK_KEY,
        50,
        REPLICA_A,
      );
      expect(acquired).toBe(true);

      await reminders.tick();
      const last = reminders.getLastTick();
      expect(last?.lockHeld).toBe(false);
      expect(last?.claimed).toBe(0);
      expect(last?.sent).toBe(0);

      // Cleanup: release the manually-acquired lock so the next test
      // starts clean.
      await stubRedis.releaseLock(REMINDER_LOCK_KEY, REPLICA_A);
    });

    it('lease expiry + status-claim: tick > 60s does not double-fire', async () => {
      // Simulate the race: replica A claims rows as PROCESSING,
      // holds the lock past the TTL, replica B acquires after expiry.
      // B's tick should see zero SCHEDULED rows (A already flipped
      // them) and exit with claimed=0.
      //
      // We exercise the same code path as the real cron tick (the
      // service.tick() method calls updateMany with the same where
      // clause). We seed one extra due reminder for this test
      // (separate from the happy-path one) so the count assertions
      // don't leak across tests.
      const seedId = await seedDueReminder('lease');
      const REPLICA_A = 'replica-a-lease';
      const REPLICA_B = 'replica-b-lease';

      // 1. Replica A acquires the lock (TTL 10s - short so the
      // same advanceTime that triggers expiry also lets B acquire).
      const acquired = await stubRedis.acquireLock(
        REMINDER_LOCK_KEY,
        10,
        REPLICA_A,
      );
      expect(acquired).toBe(true);

      // 2. Replica A's updateMany claims the rows. We call this
      // directly rather than going through tick() because we want
      // to skip the renew/release logic - we're simulating a
      // replica that crashes mid-batch. Wrap in adminSeed so the
      // claim (an admin-actor UPDATE) succeeds - keeps this test
      // independent of the CRON_SERVICE code path that the cron
      // tick uses in production.
      await adminSeed(async (db) => {
        const dueBeforeClaim = await db.reminder.count({
          where: { status: 'SCHEDULED', scheduledFor: { lte: new Date() } },
        });
        expect(dueBeforeClaim).toBeGreaterThan(0);
        const claimResult = await db.reminder.updateMany({
          where: { status: 'SCHEDULED', scheduledFor: { lte: new Date() } },
          data: {
            status: 'PROCESSING',
            claimedAt: new Date(),
            claimedBy: REPLICA_A,
          },
        });
        expect(claimResult.count).toBe(dueBeforeClaim);
      });

      // 3. Fast-forward past the lock TTL - Redis would have expired
      // the key. Our stub mimics that with advanceTime.
      stubRedis.advanceTime(11_000);

      // 4. Replica B acquires the lock (TTL 10s - short so the
      // next advanceTime also covers the new TTL window).
      const reacquired = await stubRedis.acquireLock(
        REMINDER_LOCK_KEY,
        10,
        REPLICA_B,
      );
      expect(reacquired).toBe(true);

      // 5. Fast-forward past B's TTL too, so the next acquireLock
      // (replicaB.tick inside the cron) starts fresh.
      stubRedis.advanceTime(11_000);

      // 6. Run B's full tick. Its updateMany should find zero
      // SCHEDULED rows (A already flipped them) - status-claim
      // catches the race, no duplicate fire.
      //
      // Use withReplicaId so replica B uses REPLICA_B as its lock
      // token (matching the manual acquireLock we did above). The
      // tick's acquireLock will succeed because we advanced the
      // fake clock past the TTL - Redis would have expired the key.
      const replicaB = RemindersService.withReplicaId(
        prismaService,
        stubRedis as unknown as RedisService,
        REPLICA_B,
      );
      await replicaB.tick();
      const lastB = replicaB.getLastTick();
      expect(lastB?.lockHeld).toBe(true); // B got the lock
      expect(lastB?.claimed).toBe(0); // status-claim caught the race
      expect(lastB?.sent).toBe(0); // no fires
      expect(lastB?.failed).toBe(0);

      // Verify the original row is still PROCESSING (A claimed it,
      // B did NOT touch it - exactly what we want). Wrap in adminSeed
      // so the runtime shadhil_app client can bypass the
      // owner-only reminder_select_owner policy for the assertion.
      expect(seedId).toBeDefined();
      const rows = await adminSeed(async (db) =>
        db.reminder.findMany({
          where: { id: seedId! },
          select: { id: true, status: true, claimedBy: true },
        }),
      );
      const afterB = rows[0];
      expect(afterB?.status).toBe('PROCESSING');
      expect(afterB?.claimedBy).toBe(REPLICA_A);

      // Cleanup: flip the row back to SCHEDULED + release the lock
      // so the next test starts clean. Use adminSeed so the
      // PROCESSING → SCHEDULED update succeeds - the lease-expiry
      // scenario asserts on admin-driven state changes, not the
      // CRON_SERVICE code path.
      await adminSeed(async (db) => {
        await db.reminder.updateMany({
          where: { claimedBy: REPLICA_A },
          data: { status: 'SCHEDULED', claimedAt: null, claimedBy: null },
        });
      });
      await stubRedis.releaseLock(REMINDER_LOCK_KEY, REPLICA_B);
    });
  },
);
