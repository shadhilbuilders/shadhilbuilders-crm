// Reminders service - CRUD surface + the cron processor.
//
// T-G4 (P1): the cron processor is Redis-locked with two safety nets:
//   1. LEASE RENEWAL: the per-batch loop bumps the lock TTL every 25s
//      via the Lua compare-and-set script in RedisService.renewLease.
//      A batch that runs longer than the original 50s TTL (cold
//      start with a backlog) does NOT lose the lock mid-batch.
//   2. STATUS-CLAIM IDEMPOTENCY: each reminder is claimed via
//      updateMany(SCHEDULED → PROCESSING). If two replicas race past
//      the Redis lock (e.g. lock expired and another replica grabbed
//      it during the renewal window), the second updateMany sees
//      zero rows and exits. No duplicate fire.
//
// The owned-token release is the existing Lua releaseLock() - only
// the holder of the token can DEL the key.
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';

import {
  PrismaClient,
  type Reminder,
  type ReminderStatus,
  type ReminderType,
  withRlsContext,
} from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';
import { RedisService } from '../redis/redis.module';

export const REMINDER_LOCK_KEY = 'cron:reminders:lock';
const LOCK_TTL_SEC = 50; // cron fires every 60s - keep < 60
const LOCK_RENEWAL_SEC = 25; // renew at half-life
const BATCH_SIZE = 100;

export interface ReminderListResult {
  total: number;
  rows: Array<{
    id: string;
    leadId: string;
    leadName: string;
    userId: string;
    userName: string;
    type: ReminderType;
    status: ReminderStatus;
    scheduledFor: string;
    sentAt: string | null;
    claimedAt: string | null;
    claimedBy: string | null;
    notes: string | null;
  }>;
}

/**
 * Stub delivery adapter. The full T-E2 push + T-E2b WhatsApp
 * integration is Week 7 work per the plan; for T-G4 we just need a
 * delivery sink that the cron can call to mark rows SENT. The
 * processor treats any thrown error as FAILED (the row stays
 * PROCESSING for retry next tick - recovery is handled by the
 * stuck-row query documented on Reminder.claimedAt).
 */
async function deliverReminder(_reminder: Reminder): Promise<void> {
  // No-op until Week 7 (T-E2 / T-E2b / Telegram alert).
  return;
}

@Injectable()
export class RemindersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RemindersService.name);
  // Generated once at module init. Used as the lock token so the
  // releaseLock Lua compare-and-delete only releases if WE set it.
  private readonly replicaId = randomUUID();
  // Tracks the most recent tick result for tests + ops visibility.
  private lastTick: {
    startedAt: Date;
    finishedAt: Date | null;
    claimed: number;
    sent: number;
    failed: number;
    renewedLease: boolean;
    lockHeld: boolean;
  } | null = null;

  // Injectable timer refs for tests - the @Cron fires every minute
  // in production but tests want to drive the tick manually.
  private lastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {
    // Default replica id is a fresh UUID. Tests can pass a fixed
    // value via the static `withReplicaId()` factory so the test
    // can pre-acquire the lock with a known token.
    this.replicaId = randomUUID();
  }

  // Test factory: construct a RemindersService with a known
  // replicaId so the test can pre-acquire the cron lock with the
  // same token. Without this, the test would have to introspect
  // `service.replicaId` (private) to coordinate with Redis.
  static withReplicaId(
    prismaService: PrismaService,
    redis: RedisService,
    replicaId: string,
  ): RemindersService {
    const svc = new RemindersService(prismaService, redis);
    (svc as unknown as { replicaId: string }).replicaId = replicaId;
    return svc;
  }

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  onModuleInit(): void {
    this.logger.log(`RemindersService initialized, replicaId=${this.replicaId}`);
  }

  onModuleDestroy(): void {
    if (this.lastTimer !== null) {
      clearTimeout(this.lastTimer);
      this.lastTimer = null;
    }
  }

  /**
   * GET /api/reminders - list due + recent reminders, role-scoped.
   * Currently a thin wrapper around prisma (returns the first 50
   * scheduled+processing+sent rows ordered by scheduledFor asc). The
   * full filter DTO from the api-types ReminderFilterDtoSchema will
   * land in Week 7 when the controller is fleshed out.
   */
  async list(): Promise<ReminderListResult> {
    const rows = await this.client.reminder.findMany({
      take: 50,
      orderBy: { scheduledFor: 'asc' },
      select: {
        id: true,
        leadId: true,
        userId: true,
        type: true,
        status: true,
        scheduledFor: true,
        sentAt: true,
        claimedAt: true,
        claimedBy: true,
        lead: { select: { name: true } },
        user: { select: { name: true } },
      },
    });

    // The api-types DTO doesn't yet carry notes; if you add a notes
    // column, pull it here. Returning null for the stub shape keeps
    // the contract stable.
    const total = await this.client.reminder.count();
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        leadId: r.leadId,
        leadName: r.lead.name,
        userId: r.userId,
        userName: r.user.name,
        type: r.type,
        status: r.status,
        scheduledFor: r.scheduledFor.toISOString(),
        sentAt: r.sentAt?.toISOString() ?? null,
        claimedAt: r.claimedAt?.toISOString() ?? null,
        claimedBy: r.claimedBy ?? null,
        notes: null,
      })),
    };
  }

  /**
   * Cron tick. Runs every minute via @Cron('* * * * *'). Two layers
   * of safety:
   *
   *   Layer 1: Redis lock with TTL. Only one replica processes each
   *            minute. Lua releaseLock + renewLease use compare-and-
   *            set on the lock token so we never release / renew
   *            a lock we don't own.
   *
   *   Layer 2: status-claim. updateMany(SCHEDULED → PROCESSING) is
   *            atomic at the row level. If a second replica somehow
   *            passes Layer 1 (e.g. lock expired during renewal),
   *            its updateMany sees zero rows and exits cleanly.
   *
   * The cron returns void; errors are logged. We deliberately do
   * NOT throw from a @Cron handler - that breaks the schedule
   * loop in some @nestjs/schedule versions.
   *
   * RLS: shadhil_app has BYPASSRLS (migration
   * 20260904091200_cron_bypassrls) so the cron can claim any
   * reminder row regardless of which user owns it. The audit log
   * still uses withRlsContext for writes (via the cron service
   * account), so the audit identity is "service-cron", not
   * "shadhil".
   */
  @Cron('* * * * *')
  async processDueReminders(): Promise<void> {
    await this.tick();
  }

  /**
   * Public wrapper around the cron body. Tests call this directly
   * to drive the tick without waiting for the minute boundary.
   */
  async tick(): Promise<void> {
    const startedAt = new Date();
    const tick: {
      startedAt: Date;
      finishedAt: Date | null;
      claimed: number;
      sent: number;
      failed: number;
      renewedLease: boolean;
      lockHeld: boolean;
    } = {
      startedAt,
      finishedAt: null,
      claimed: 0,
      sent: 0,
      failed: 0,
      renewedLease: true,
      lockHeld: false,
    };
    this.lastTick = tick;

    // Layer 1: Redis lock
    const acquired = await this.redis.acquireLock(
      REMINDER_LOCK_KEY,
      LOCK_TTL_SEC,
      this.replicaId,
    );
    if (!acquired) {
      this.logger.debug(
        `Skipping tick - another replica holds ${REMINDER_LOCK_KEY}`,
      );
      tick.finishedAt = new Date();
      return;
    }
    tick.lockHeld = true;

    try {
      // Lease renewal timer - bump the TTL every half-life so the
      // lock doesn't expire mid-batch.
      const renewTimer = setInterval(() => {
        void this.redis
          .renewLease(REMINDER_LOCK_KEY, this.replicaId, LOCK_TTL_SEC)
          .then((renewed) => {
            tick.renewedLease = renewed;
            if (!renewed) {
              this.logger.warn(
                `Lost lease on ${REMINDER_LOCK_KEY} mid-tick; stopping early`,
              );
            }
          })
          .catch((err: unknown) => {
            this.logger.error(
              `Lease renewal error: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }, LOCK_RENEWAL_SEC * 1000);

      try {
        // Layer 2: claim. updateMany(SCHEDULED → PROCESSING) is the
        // idempotency primitive. A second cron that somehow passes
        // the lock check (e.g. during the renewal window) will see
        // zero rows here and exit cleanly - no duplicate fire.
        //
        // T-CRONS (2026-09-07): wrapped in withRlsContext as
        // CRON_SERVICE so the reminder_cron_service RLS policy
        // matches - the cron is a service account, not a real user,
        // and can't satisfy the owner-only reminder_write_owner
        // policy. See
        // packages/database/prisma/migrations/20260907090000_reminder_cron_service_policy/
        // for the policy and known-runtime-bugs.md Bug 8 for context.
        const claimResult = await withRlsContext(
          this.client,
          {
            userId: 'cron-service',
            role: 'CRON_SERVICE',
            teamId: null,
            organizationId: 'ceid01lpfe1esm8jwsxid41k28',
          },
          async (tx) =>
            (tx as unknown as PrismaClient).reminder.updateMany({
              where: {
                status: 'SCHEDULED',
                scheduledFor: { lte: new Date() },
              },
              data: {
                status: 'PROCESSING',
                claimedAt: new Date(),
                claimedBy: this.replicaId,
              },
            }),
        );
        const claimed = { count: claimResult.count };
        tick.claimed = claimed.count;

        if (claimed.count === 0) {
          tick.finishedAt = new Date();
          return;
        }

        // Fetch the rows we just claimed (filter by claimedBy to
        // avoid grabbing rows another replica claimed in a race).
        const due = await withRlsContext(
          this.client,
          {
            userId: 'cron-service',
            role: 'CRON_SERVICE',
            teamId: null,
            organizationId: 'ceid01lpfe1esm8jwsxid41k28',
          },
          async (tx) =>
            (tx as unknown as PrismaClient).reminder.findMany({
              where: {
                status: 'PROCESSING',
                claimedBy: this.replicaId,
              },
              take: BATCH_SIZE,
              orderBy: { scheduledFor: 'asc' },
            }),
        );

        for (const reminder of due) {
          if (!tick.renewedLease) {
            this.logger.warn(
              `Aborting batch at row ${reminder.id} - lease lost`,
            );
            break;
          }
          try {
            await deliverReminder(reminder);
            await withRlsContext(
              this.client,
              {
                userId: 'cron-service',
                role: 'CRON_SERVICE',
                teamId: null,
                organizationId: 'ceid01lpfe1esm8jwsxid41k28',
              },
              async (tx) =>
                (tx as unknown as PrismaClient).reminder.update({
                  where: { id: reminder.id },
                  data: {
                    status: 'SENT',
                    sentAt: new Date(),
                    claimedAt: null,
                    claimedBy: null,
                  },
                }),
            );
            tick.sent++;
          } catch (err) {
            // FAILED is sticky - the row stays PROCESSING until the
            // stuck-row recovery flips it back to SCHEDULED (or the
            // operator re-queues). Per Plan §12, NO_SHOW_STAFF retries
            // are handled by re-scheduling, not by cron retries.
            this.logger.error(
              `Reminder ${reminder.id} delivery failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            await withRlsContext(
              this.client,
              {
                userId: 'cron-service',
                role: 'CRON_SERVICE',
                teamId: null,
                organizationId: 'ceid01lpfe1esm8jwsxid41k28',
              },
              async (tx) =>
                (tx as unknown as PrismaClient).reminder.update({
                  where: { id: reminder.id },
                  data: { status: 'FAILED' },
                }),
            );
            tick.failed++;
          }
        }
      } finally {
        clearInterval(renewTimer);
      }
    } finally {
      // Layer 1 cleanup: releaseLock is a Lua compare-and-delete on
      // our token. If a different replica owns the lock by now (e.g.
      // our lease expired and someone else acquired it), the script
      // returns 0 and we don't delete - correct behavior.
      await this.redis.releaseLock(REMINDER_LOCK_KEY, this.replicaId);
      tick.finishedAt = new Date();
    }
  }

  /**
   * Test-only accessor for the most recent tick. Production code
   * shouldn't depend on this - it's for the unit test that
   * asserts "tick > 60s does not double-fire" (Plan §18 / T-G4).
   */
  getLastTick(): typeof this.lastTick {
    return this.lastTick;
  }
}
