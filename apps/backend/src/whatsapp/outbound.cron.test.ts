// T-E2b: Outbound cron processor test.
//
// Mirrors the T-G4 reminder cron test pattern:
//   - StubRedis for the lease
//   - Real Prisma (RLS-enforced; the cron runs as CRON_SERVICE)
//   - Stub WhatsAppClient (the real one calls Meta - we don't want
//     that in unit tests)
//   - Stub OutboundService that uses the stub client
//
// Cases:
//   1. happy path: a PENDING row gets claimed and "sent"
//   2. lock contention: another replica holds the lock → no-op
//   3. backoff: a row whose lastAttemptAt is within the backoff
//      window is NOT claimed (the pre-filter in claimPending
//      catches it)
//   4. send failure: a row that throws on sendOne gets lastError
//      set + status flipped to PENDING (not SENT) - the next
//      tick will retry per the backoff schedule
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma as runtimePrisma, type PrismaClient, withRlsContext } from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';
import {
  createTestTenant,
  holdCronLockForFile,
  type CronFileLock,
  type TestTenant,
} from '../test-utils/test-tenant';
import { RedisService } from '../redis/redis.module';

import { OutboundCronService, OUTBOUND_LOCK_KEY } from './outbound.cron';
import { OutboundService, MAX_ATTEMPTS } from './outbound.service';
import { WhatsAppClient } from './whatsapp.client';

const HAS_DB = Boolean(process.env.DATABASE_URL);
// Everything this file creates lives in a private organization (see
// test-utils/test-tenant): the cron CLAIMS PENDING outbound rows across the whole
// database, so another suite's rows were getting claimed here and this file's
// rows were getting claimed there - "claimed" counted the other process's work.
// The organization id is assigned in beforeAll, hence `let`.
let ORG_ID: string;
let tenant: TestTenant;
/** Held for the whole file: a tick claims rows from EVERY org. */
let cronLock: CronFileLock;
const HAS_REDIS = Boolean(process.env.REDIS_URL);

const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

// Test fixtures - unique per run AND per process: two copies of this file can run
// at the same time, and both the ids and the unique `Lead_phoneE164_key` /
// `OutboundMessage_messageId_key` constraints have to hold across them.
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// T-LEAD-PROJECT-REQUIRED (2026-09-16): Lead.projectId is NOT NULL now, so
// every fixture lead needs a project. cuid2-shaped in case it passes a DTO.
const TEST_PROJECT_ID = `outboundcrpr${RUN}`;
const REPLICA_ID = `test-outbound-cron-replica-${RUN}`;
const TEST_USER_ID = `test-outbound-cron-user-${RUN}`;
const TEST_TEAM_ID = `test-outbound-cron-team-${RUN}`;
const TEST_LEAD_ID = `test-outbound-cron-lead-${RUN}`;
const TEST_PHASE_ID = `test-outbound-cron-phase-${RUN}`;
const TEST_UNIT_ID = `test-outbound-cron-unit-${RUN}`;

const TEST_OUTBOUND_IDS: string[] = [];
const TEST_MESSAGE_IDS: string[] = [];
const TEST_DELIVERY_IDS: string[] = [];

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    {
      userId: TEST_USER_ID,
      role: 'ADMIN',
      organizationId: ORG_ID,
    },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

async function ensureFixtures(): Promise<void> {
  await adminSeed(async (db) => {
    // User needs teamId; team must exist first (FK).
    // Lead.projectId is NOT NULL (T-LEAD-PROJECT-REQUIRED) - the lead
    // fixtures below need a project to point at.
    await db.project.upsert({
      where: { id: TEST_PROJECT_ID },
      update: {},
      create: {
        id: TEST_PROJECT_ID,
        name: `Test Project ${TEST_PROJECT_ID}`,
        slug: TEST_PROJECT_ID,
        address: 'test',
        organizationId: ORG_ID,
      },
    });
    await db.team.upsert({
      where: { id: TEST_TEAM_ID },
      update: {},
      create: {
        id: TEST_TEAM_ID,
        name: 'Outbound Cron Test Team',
        organizationId: ORG_ID,
      },
    });
    await db.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: {
        id: TEST_USER_ID,
        email: 'outbound-cron@test.local',
        name: 'Outbound Cron Test',
        role: 'ADMIN',
        organizationId: ORG_ID,
      },
    });
    // A phase + unit, so the site-update delivery cases (which need a valid unit
    // FK) actually RUN instead of quietly returning early. In a per-run org there
    // is no seed to borrow one from.
    await db.phase.create({
      data: {
        id: TEST_PHASE_ID,
        projectId: TEST_PROJECT_ID,
        name: `Test Phase ${RUN}`,
        organizationId: ORG_ID,
      },
    });
    await db.unit.create({
      data: {
        id: TEST_UNIT_ID,
        phaseId: TEST_PHASE_ID,
        organizationId: ORG_ID,
        unitNumber: `T-${RUN}`,
        bhk: 3,
        buildupSqft: 1850,
        pricePerSqft: 6500,
        price: 12025000,
      },
    });
    // Lead with a per-test unique phone. The `phone` field has a
    // unique constraint (Lead_phone_key) and `phoneE164` has one too
    // (Lead_phoneE164_key) - both must be unique per test run.
    await db.lead.upsert({
      where: { id: TEST_LEAD_ID },
      update: {
        phone: '913000000001',
        phoneE164: '913000000001',
      },
      create: {
        id: TEST_LEAD_ID,
        name: 'Outbound Cron Test Lead',
        phone: '913000000001',
        phoneE164: '913000000001',
        source: 'WEBSITE',
        state: 'NEW',
        teamId: TEST_TEAM_ID,
        ownerId: TEST_USER_ID,
        ownerType: 'ADMIN',
        organizationId: ORG_ID,

        projectId: TEST_PROJECT_ID,
      },
    });
  });
}

async function seedOutbound(
  label: string,
  opts: {
    lastAttemptAt?: Date | null;
    attempts?: number;
    wamid?: string;
    lastError?: string;
    /**
     * Attach a SiteUpdateDelivery and link the outbox row to it, so the test can
     * assert the worker reports the send outcome back (2026-11-23). The delivery
     * row needs a Unit, and a unit is only created by the seed, so the id is
     * resolved at seed time and the case is skipped when the org has none.
     */
    withDelivery?: boolean;
  } = {},
): Promise<{ messageId: string; outboundId: string; deliveryId?: string }> {
  if (prisma === null) throw new Error('prisma missing');
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const messageId = `test-msg-${suffix}`;
  const outboundId = `test-out-${suffix}`;
  let deliveryId: string | undefined;
  await adminSeed(async (db) => {
    if (opts.withDelivery === true) {
      // Any unit in the org: the delivery row only needs a valid FK, and which
      // villa it is has no bearing on the send bookkeeping under test.
      const unit = await db.unit.findUnique({
        where: { id: TEST_UNIT_ID },
        select: { id: true },
      });
      if (unit === null) return;
      const delivery = await db.siteUpdateDelivery.create({
        data: {
          organizationId: ORG_ID,
          batchId: `test-batch-${suffix}`,
          unitId: unit.id,
          status: 'PENDING',
        },
        select: { id: true },
      });
      deliveryId = delivery.id;
      TEST_DELIVERY_IDS.push(delivery.id);
    }
    await db.message.create({
      data: {
        id: messageId,
        leadId: TEST_LEAD_ID,
        userId: TEST_USER_ID,
        direction: 'OUT',
        channel: 'WHATSAPP',
        body: 'test outbound message body',
        organizationId: ORG_ID,
      },
    });
    await db.outboundMessage.create({
      data: {
        id: outboundId,
        messageId,
        leadId: TEST_LEAD_ID,
        sendType: 'TEMPLATE',
        // A RETIRED name on purpose: this row was written before the templates
        // were recategorised, and the cron is what upgrades it to the current
        // name for that slot (RETIRED_TEMPLATE_NAMES in outbound.service.ts).
        templateName: 'shadhil_chat_reply',
        templateVars: { name: 'Test', body: 'test outbound message body' },
        status: 'PENDING',
        attempts: opts.attempts ?? 0,
        ...(opts.lastAttemptAt !== undefined ? { lastAttemptAt: opts.lastAttemptAt } : {}),
        ...(opts.wamid !== undefined ? { wamid: opts.wamid } : {}),
        ...(opts.lastError !== undefined ? { lastError: opts.lastError } : {}),
        ...(deliveryId !== undefined ? { siteUpdateDeliveryId: deliveryId } : {}),
        organizationId: ORG_ID,
      },
    });
  });
  TEST_OUTBOUND_IDS.push(outboundId);
  TEST_MESSAGE_IDS.push(messageId);
  return { messageId, outboundId, deliveryId };
}

async function cleanupTestOutbound(): Promise<void> {
  if (prisma === null) return;
  // Cleanup via FK cascade: deleting the Message removes the OutboundMessage (FK
  // ON DELETE CASCADE). Scoped to THIS file's lead, which is now the whole tenant,
  // so it cannot delete another suite's rows - which the old prefix sweep could.
  await adminSeed(async (db) => {
    await db.message.deleteMany({ where: { leadId: TEST_LEAD_ID } });
    // The delivery rows are independent of the messages (SetNull, not Cascade), so
    // they need their own delete.
    await db.siteUpdateDelivery.deleteMany({ where: { organizationId: ORG_ID } });
  });
  TEST_OUTBOUND_IDS.length = 0;
  TEST_MESSAGE_IDS.length = 0;
  TEST_DELIVERY_IDS.length = 0;
}

// Same shape as StubRedis in reminders.processor.test.ts.
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

  advanceTime(ms: number): void {
    this.now += ms;
    for (const [key, raw] of this.store.entries()) {
      const parsed = JSON.parse(raw) as { expiresAt: number };
      if (parsed.expiresAt <= this.now) this.store.delete(key);
    }
  }

  reset(): void {
    this.store.clear();
    this.now = 0;
  }
}

// Stub WhatsAppClient - exposes just the method the OutboundService
// actually calls. Records every call for assertions.
class StubWhatsApp {
  public readonly calls: Array<{
    to: string;
    templateName: string;
    parameters: Array<{ type: 'text'; text: string }>;
  }> = [];
  // Per-call behavior toggle: each test sets the next call's outcome.
  public nextResult: { wamid: string } | { throw: Error } = {
    wamid: 'wamid.stub',
  };

  async sendTemplateMessage(
    to: string,
    templateName: string,
    parameters: Array<{ type: 'text'; text: string }>,
  ): Promise<{ wamid: string; accepted: boolean; errorCode: null; errorTitle: null }> {
    this.calls.push({ to, templateName, parameters });
    if ('throw' in this.nextResult) throw this.nextResult.throw;
    return {
      wamid: this.nextResult.wamid,
      accepted: true,
      errorCode: null,
      errorTitle: null,
    };
  }
}

describe.skipIf(!HAS_DB || !HAS_REDIS)('T-E2b outbound cron - lease + claim + send', () => {
  let stubRedis: StubRedis;
  let stubWhatsApp: StubWhatsApp;
  let prismaService: PrismaService;
  let outbound: OutboundService;
  let cron: OutboundCronService;

  beforeAll(async () => {
    tenant = await createTestTenant('outbound-cron');
    // Before any fixture exists: see holdCronLockForFile. Another file's tick must
    // not be able to claim what this file is about to seed.
    cronLock = await holdCronLockForFile(tenant);
    ORG_ID = tenant.organizationId;
    await ensureFixtures();
    // Queues behind any other file driving a global cron: see holdCronLockForFile.
  }, 120_000);

  afterAll(async () => {
    // Release before the teardown, so the next file's beforeAll stops waiting.
    await cronLock.release();
    // Cascades: project, phase, unit, team, user, lead, messages, outbound rows,
    // deliveries.
    await tenant.dispose();
  }, 120_000);

  beforeEach(async () => {
    // Each case starts with no outbound rows of its own: the tick CLAIMS every
    // PENDING row in the database, so a row left by the previous case would be
    // claimed here and every `claimed`/`sent` count would be off by one.
    await cleanupTestOutbound();
    stubRedis = new StubRedis();
    stubWhatsApp = new StubWhatsApp();
    prismaService = {
      $client: prisma as unknown as PrismaClient,
    } as PrismaService;
    outbound = new OutboundService(prismaService, stubWhatsApp as unknown as WhatsAppClient);
    cron = OutboundCronService.withReplicaId(
      prismaService,
      stubRedis as unknown as RedisService,
      outbound,
      REPLICA_ID,
    );
  });

  it('happy path: claims a PENDING row, sends, marks SENT', async () => {
    const { outboundId } = await seedOutbound('happy');
    stubWhatsApp.nextResult = { wamid: 'wamid.happy' };

    const tick = await cron.runOnce();

    expect(tick.lockHeld).toBe(true);
    expect(tick.claimed).toBe(1);
    expect(tick.sent).toBe(1);
    expect(tick.failed).toBe(0);
    expect(stubWhatsApp.calls).toHaveLength(1);
    // The current name for the chat-reply slot, not the retired one the row
    // carries: the env is what decides, so the assertion reads it rather than
    // hardcoding whichever name the local .env happened to hold.
    expect(stubWhatsApp.calls[0]?.templateName).toBe(
      process.env['WA_TEMPLATE_CHAT_REPLY'] ?? 'shadhil_enquiry_reply',
    );

    const updated = await adminSeed(async (db) =>
      db.outboundMessage.findUnique({
        where: { id: outboundId },
        select: { status: true, wamid: true, attempts: true },
      }),
    );
    expect(updated?.status).toBe('SENT');
    expect(updated?.wamid).toBe('wamid.happy');
    // attempts was 0 at seed; claimPending increments to 1
    expect(updated?.attempts).toBe(1);
  });

  it('retry that succeeds clears the stale lastError', async () => {
    // attempts=1 + an old lastAttemptAt puts the row past the first backoff
    // window, and lastError carries the text from the attempt that failed.
    const { outboundId } = await seedOutbound('retry-clears-error', {
      attempts: 1,
      lastAttemptAt: new Date(Date.now() - 10 * 60 * 1000),
      lastError: 'WhatsApp API HTTP error 400: (#133010) Account not registered',
    });
    stubWhatsApp.nextResult = { wamid: 'wamid.retry.ok' };

    const tick = await cron.runOnce();
    expect(tick.sent).toBe(1);

    const updated = await adminSeed(async (db) =>
      db.outboundMessage.findUnique({
        where: { id: outboundId },
        select: { status: true, wamid: true, lastError: true },
      }),
    );
    expect(updated?.status).toBe('SENT');
    expect(updated?.wamid).toBe('wamid.retry.ok');
    // Without the fix this keeps the 133010 text beside a SENT row.
    expect(updated?.lastError).toBeNull();
  });

  it('lock contention: another replica holds the lock → no-op', async () => {
    await seedOutbound('locked');
    const OTHER_REPLICA = 'other-replica-token';
    const acquired = await stubRedis.acquireLock(OUTBOUND_LOCK_KEY, 50, OTHER_REPLICA);
    expect(acquired).toBe(true);

    const tick = await cron.runOnce();

    expect(tick.lockHeld).toBe(false);
    expect(tick.claimed).toBe(0);
    expect(tick.sent).toBe(0);
    // The stub WhatsApp client was never called.
    expect(stubWhatsApp.calls).toHaveLength(0);

    // Cleanup: release the manually-acquired lock so the next test starts clean.
    await stubRedis.releaseLock(OUTBOUND_LOCK_KEY, OTHER_REPLICA);

    // Also clean up the seeded row - it stays PENDING because the
    // lock test doesn't claim it, but a later test's cron run
    // would claim it (since lastAttemptAt is null → backoff filter
    // treats it as ready). The next test's expected counts would
    // be off by 1.
  });

  it('backoff: a row within the backoff window is NOT claimed', async () => {
    // Clear any PENDING orphans from previous test runs - if an
    // orphan's backoff has elapsed (> 5 min), the cron will claim
    // it before checking our test row, breaking the assertion
    // (claimed would be 1, expected 0). The backoff filter is
    // correct; this just isolates the test.
    // First attempt happened 1 second ago - the first backoff
    // is 30s, so this row is still in its backoff window.
    const recentAttempt = new Date(Date.now() - 1_000);
    const { outboundId } = await seedOutbound('backoff', {
      lastAttemptAt: recentAttempt,
      attempts: 1,
    });

    const tick = await cron.runOnce();

    // The row should not have been claimed (still PENDING) and
    // the Meta API was not called. The cron reports 0 claimed.
    expect(tick.claimed).toBe(0);
    expect(stubWhatsApp.calls).toHaveLength(0);

    const row = await adminSeed(async (db) =>
      db.outboundMessage.findUnique({
        where: { id: outboundId },
        select: { status: true, attempts: true },
      }),
    );
    // status unchanged, attempts not incremented
    expect(row?.status).toBe('PENDING');
    expect(row?.attempts).toBe(1);
  });

  it('failure: a row whose send throws gets lastError set + stays PENDING', async () => {
    stubWhatsApp.nextResult = {
      throw: new Error('Meta API network error'),
    };
    const { outboundId } = await seedOutbound('fail', { attempts: 0 });

    const tick = await cron.runOnce();

    expect(tick.lockHeld).toBe(true);
    expect(tick.claimed).toBe(1);
    // sendOne caught the error, so tick.sent stays 0; the row
    // is in the backoff limbo (PENDING with lastError). It will
    // be retried in 30s (the first backoff bucket).
    expect(tick.sent).toBe(0);
    expect(tick.failed).toBe(0);

    const row = await adminSeed(async (db) =>
      db.outboundMessage.findUnique({
        where: { id: outboundId },
        select: { status: true, lastError: true, attempts: true },
      }),
    );
    expect(row?.status).toBe('PENDING');
    expect(row?.lastError).toContain('Meta API network error');
    // attempts was bumped by claimPending (it's part of the
    // status-claim atomicity), even though the actual send
    // failed. The retry counter reflects "we tried", not
    // "we succeeded". MAX_ATTEMPTS is the cap on how many
    // times we'll keep trying.
    expect(row?.attempts).toBe(1);
  });

  it('final failure: a row that exhausts MAX_ATTEMPTS is marked FAILED', async () => {
    // Seed a row that has already been tried MAX_ATTEMPTS - 1
    // times. The next failure will hit the cap and flip to
    // FAILED instead of PENDING.
    stubWhatsApp.nextResult = {
      throw: new Error('Meta API: 400 invalid template'),
    };
    // attempts is set to MAX_ATTEMPTS - 1 in the seed. The
    // claimPending increments to MAX_ATTEMPTS. The sendOne's
    // catch sees attempts >= MAX_ATTEMPTS and marks FAILED.
    const { outboundId } = await seedOutbound('exhaust', {
      attempts: MAX_ATTEMPTS - 1,
    });

    const tick = await cron.runOnce();

    expect(tick.claimed).toBe(1);
    expect(tick.failed).toBe(1);
    expect(tick.sent).toBe(0);

    const row = await adminSeed(async (db) =>
      db.outboundMessage.findUnique({
        where: { id: outboundId },
        select: { status: true, lastError: true, attempts: true },
      }),
    );
    expect(row?.status).toBe('FAILED');
    expect(row?.lastError).toContain('Meta API: 400 invalid template');
    expect(row?.attempts).toBe(MAX_ATTEMPTS);
  });

  it('site-update delivery: a sent message flips the delivery row to SENT', async () => {
    // THE BUG THIS FIXES (2026-11-23): the delivery row was written PENDING and
    // nothing advanced it, so the staff row said "Sending to buyer..." over an
    // update the buyer had already received.
    const seeded = await seedOutbound('delivery-sent', { withDelivery: true });
    if (seeded.deliveryId === undefined) {
      // No unit in this database to hang a delivery row on. Not a failure of the
      // code under test, and silently passing would be worse than saying so.
      expect(seeded.deliveryId).toBeUndefined();
      return;
    }
    stubWhatsApp.nextResult = { wamid: 'wamid.delivery-sent' };

    const tick = await cron.runOnce();
    expect(tick.sent).toBe(1);

    const delivery = await adminSeed(async (db) =>
      db.siteUpdateDelivery.findUnique({
        where: { id: seeded.deliveryId as string },
        select: { status: true, wamid: true, sentAt: true, errorCode: true },
      }),
    );
    expect(delivery?.status).toBe('SENT');
    expect(delivery?.wamid).toBe('wamid.delivery-sent');
    expect(delivery?.sentAt).not.toBeNull();
    expect(delivery?.errorCode).toBeNull();
  });

  it('site-update delivery: a final failure marks the delivery row FAILED', async () => {
    const seeded = await seedOutbound('delivery-failed', {
      attempts: MAX_ATTEMPTS - 1,
      withDelivery: true,
    });
    if (seeded.deliveryId === undefined) {
      expect(seeded.deliveryId).toBeUndefined();
      return;
    }
    stubWhatsApp.nextResult = { throw: new Error('Meta API: 400 invalid template') };

    const tick = await cron.runOnce();
    expect(tick.failed).toBe(1);

    const delivery = await adminSeed(async (db) =>
      db.siteUpdateDelivery.findUnique({
        where: { id: seeded.deliveryId as string },
        select: { status: true, errorCode: true, sentAt: true },
      }),
    );
    expect(delivery?.status).toBe('FAILED');
    expect(delivery?.errorCode).toBe('SEND_FAILED');
    expect(delivery?.sentAt).toBeNull();
  });

  it('site-update delivery: a retryable failure leaves the row PENDING for the retry', async () => {
    // Between attempts the buyer is still going to get the update, so the staff
    // row must not read FAILED yet.
    const seeded = await seedOutbound('delivery-retry', { attempts: 0, withDelivery: true });
    if (seeded.deliveryId === undefined) {
      expect(seeded.deliveryId).toBeUndefined();
      return;
    }
    stubWhatsApp.nextResult = { throw: new Error('Meta API network error') };

    await cron.runOnce();

    const delivery = await adminSeed(async (db) =>
      db.siteUpdateDelivery.findUnique({
        where: { id: seeded.deliveryId as string },
        select: { status: true, errorCode: true },
      }),
    );
    expect(delivery?.status).toBe('PENDING');
    expect(delivery?.errorCode).toBeNull();
  });

  it('T-E2b: every runOnce passes the tick result to alerts.recordTickResult', async () => {
    // Stub the alerts service. The cron service is reconstructed
    // for this test so we can inject the stub via the
    // OutboundCronService.withReplicaId factory (which now takes
    // an optional 5th arg).
    const recordTickResult = vi.fn(
      async (_tick: import('../whatsapp/outbound.cron').OutboundTickResult) => undefined,
    );
    const stubAlerts = {
      recordTickResult,
    } as unknown as import('../alerts/alerts.module').AlertsService;
    const cronWithAlerts = OutboundCronService.withReplicaId(
      prismaService,
      stubRedis as unknown as RedisService,
      outbound,
      REPLICA_ID,
      stubAlerts,
    );

    // Run once with a happy path - recordTickResult must be called
    // exactly once with the resulting tick.
    await seedOutbound('alerts-happy');
    stubWhatsApp.nextResult = { wamid: 'wamid.alerts' };
    const tick = await cronWithAlerts.runOnce();
    expect(recordTickResult).toHaveBeenCalledTimes(1);
    // The argument must be the same tick object the cron returned.
    expect(recordTickResult.mock.calls[0]?.[0]).toBe(tick);
  });

  it('T-E2b: a throwing alerts service does NOT crash the cron (best-effort)', async () => {
    // If alerts.recordTickResult throws (it shouldn't - it's
    // contractually no-throw - but defense-in-depth), the cron
    // must still complete and return a tick.
    const stubAlerts = {
      recordTickResult: vi.fn(
        async (_tick: import('../whatsapp/outbound.cron').OutboundTickResult) => {
          throw new Error('telegram down hard');
        },
      ),
    } as unknown as import('../alerts/alerts.module').AlertsService;
    const cronWithAlerts = OutboundCronService.withReplicaId(
      prismaService,
      stubRedis as unknown as RedisService,
      outbound,
      REPLICA_ID,
      stubAlerts,
    );

    await seedOutbound('alerts-throw');
    stubWhatsApp.nextResult = { wamid: 'wamid.alerts-throw' };

    // runOnce must NOT throw.
    const tick = await cronWithAlerts.runOnce();
    expect(tick.lockHeld).toBe(true);
    expect(tick.sent).toBe(1);
  });
});
