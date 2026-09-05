// T-E2b: OutboundMessage cron processor.
//
// Wakes up every 5 seconds, claims a batch of PENDING OutboundMessage
// rows (via the existing outbox claim-lease in OutboundService.claimPending),
// and calls OutboundService.sendOne for each. sendOne handles the
// Meta API call, the success/failure path, the backoff schedule, and
// the MAX_ATTEMPTS cap. The cron is a thin orchestrator.
//
// Safety nets (mirroring the T-G4 reminders processor):
//   1. Redis lease - `cron:outbound:lock`, TTL 30s. Only one replica
//      per tick can claim a batch. If a tick takes > 30s (very large
//      backlog), the lock expires and a peer replica may pick up -
//      safe because the claim is via updateMany(status: PENDING) and
//      the second replica sees zero rows (status-claim idempotency).
//   2. Per-row try/catch - one row's send failure doesn't abort the
//      batch. The catch in sendOne already writes lastError + flips
//      status to PENDING/FAILED per the backoff schedule.
//
// Tick frequency: 5s (the user spec; Meta's API can handle a small
// burst every 5s without rate limiting). The reminder cron runs at
// 60s because reminders are time-of-day-anchored; outbound is latency-
// sensitive (staff just hit "send" in the UI) so 5s is right.
//
// Tests: the @Cron schedule is bypassed by `runOnce()` (a public
// method, same shape as RemindersService). Tests pre-acquire the
// Redis lock with a known token via `withReplicaId` and drive
// `runOnce()` directly.

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';

import { type PrismaClient, withRlsContext } from '@shadhil/database';

import { AlertsService } from '../alerts/alerts.module';
import { PrismaService } from '../prisma/prisma.module';
import { RedisService } from '../redis/redis.module';

import { OutboundService } from './outbound.service';

export const OUTBOUND_LOCK_KEY = 'cron:outbound:lock';
const LOCK_TTL_SEC = 30;
const BATCH_SIZE = 50;

export interface OutboundTickResult {
  startedAt: Date;
  finishedAt: Date;
  lockHeld: boolean;
  claimed: number;
  sent: number;
  failed: number;
  skippedBackoff: number;
}

@Injectable()
export class OutboundCronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboundCronService.name);
  // Lock token - releaseLock is a compare-and-delete on this value.
  private readonly replicaId = randomUUID();

  // Last-tick accessor for ops visibility + tests.
  private lastTick: OutboundTickResult | null = null;

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(OutboundService) private readonly outbound: OutboundService,
    // T-E2b: optional so the cron works without AlertsModule wired in
    // (e.g. the cron's own test harness constructs it directly with
    // 3 args). When AlertsModule is imported (the production path),
    // the AlertsService is injected automatically.
    @Optional() @Inject(AlertsService) private readonly alerts?: AlertsService,
  ) {}

  /** Test factory: construct with a known replicaId so the test can
   *  pre-acquire the cron lock with the same token. */
  static withReplicaId(
    prismaService: PrismaService,
    redis: RedisService,
    outbound: OutboundService,
    replicaId: string,
    alerts?: AlertsService,
  ): OutboundCronService {
    const svc = new OutboundCronService(
      prismaService,
      redis,
      outbound,
      alerts,
    );
    (svc as unknown as { replicaId: string }).replicaId = replicaId;
    return svc;
  }

  onModuleInit(): void {
    this.logger.log(
      `OutboundCronService initialized, replicaId=${this.replicaId}, tick=5s`,
    );
  }

  onModuleDestroy(): void {
    // No persistent timer - @Cron manages its own. Nothing to clear.
  }

  /** @Cron wrapper. Bypasses the lock + runOnce path that tests use. */
  @Cron('*/5 * * * * *')
  async tick(): Promise<void> {
    await this.runOnce();
  }

  /** Test-friendly public entry. Acquires the lease, claims a batch,
   *  sends each row, releases the lease. */
  async runOnce(): Promise<OutboundTickResult> {
    const tick: OutboundTickResult = {
      startedAt: new Date(),
      finishedAt: new Date(0),
      lockHeld: false,
      claimed: 0,
      sent: 0,
      failed: 0,
      skippedBackoff: 0,
    };

    const acquired = await this.redis.acquireLock(
      OUTBOUND_LOCK_KEY,
      LOCK_TTL_SEC,
      this.replicaId,
    );
    if (!acquired) {
      tick.lockHeld = false;
      tick.finishedAt = new Date();
      this.lastTick = tick;
      this.logger.debug('Skipping tick - another replica holds cron:outbound:lock');
      return tick;
    }
    tick.lockHeld = true;

    try {
      // Claim a batch. claimPending already filters by backoff
      // (rows with lastAttemptAt within the backoff window are
      // skipped - see OutboundService.claimPending). We track
      // "skippedBackoff" via the gap between rows-returned and
      // rows-claimed.
      const batch = await this.outbound.claimPending(this.replicaId, BATCH_SIZE);
      tick.claimed = batch.length;
      // Note: claimPending's "ready" filter rejects backoff-window
      // rows before the updateMany, so we don't have a separate
      // counter for them. The `claimed` count is what was actually
      // transitioned to SENDING. The pre-filter population is
      // bounded by BATCH_SIZE * 3 in OutboundService.

      for (const row of batch) {
        try {
          // sendOne handles: Meta API call, status update on
          // success (→ SENT), error logging + backoff reset on
          // failure (→ PENDING with lastError; or FAILED if
          // attempts >= MAX_ATTEMPTS). The CRON_SERVICE RLS
          // bypass on OutboundMessage (added in T-E2b inbound
          // commit) lets the typed update inside sendOne succeed
          // via withRlsContext - no more Prisma 7 raw-SQL
          // workaround needed here.
          await this.outbound.sendOne(row);
          // Read back the row to count outcomes. (sendOne returns
          // the updated row but we count via the DB to avoid
          // double-counting in the rare PENDING-vs-FAILED race.)
          // Must be in RLS context - bare shadhil_app has no
          // permission to SELECT OutboundMessage without a matching
          // policy.
          const updated = await withRlsContext(
            this.prismaService.$client,
            { userId: 'CRON_SERVICE', role: 'CRON_SERVICE', teamId: '' },
            async (tx) =>
              (tx as unknown as PrismaClient).outboundMessage.findUnique({
                where: { id: row.id },
                select: { status: true, wamid: true },
              }),
          );
          if (updated?.status === 'SENT') tick.sent += 1;
          else if (updated?.status === 'FAILED') tick.failed += 1;
          // PENDING rows (backoff / retry case) aren't counted in
          // sent or failed - they're in flight, will be retried.
        } catch (err) {
          // sendOne catches its own errors, but a DB-level error
          // (e.g. the RLS workaround timing out) could escape.
          // Log and continue - don't abort the batch.
          this.logger.error(
            `outbound row ${row.id} crashed in cron: ${err instanceof Error ? err.message : String(err)}`,
          );
          tick.failed += 1;
        }
      }
    } finally {
      await this.redis.releaseLock(OUTBOUND_LOCK_KEY, this.replicaId);
      tick.finishedAt = new Date();
      this.lastTick = tick;
    }

    if (tick.claimed > 0 || tick.failed > 0) {
      this.logger.log(
        `outbound tick claimed=${tick.claimed} sent=${tick.sent} failed=${tick.failed}`,
      );
    }

    // T-E2b: feed the tick into the alerts service. Best-effort -
    // AlertsService.recordTickResult never throws. If AlertsModule
    // isn't wired (alerts === undefined), this is a no-op skip.
    if (this.alerts !== undefined) {
      try {
        await this.alerts.recordTickResult(tick);
      } catch (err) {
        // Defense-in-depth: the alerts service is supposed to be
        // no-throw, but if it ever does, we MUST NOT crash the cron
        // (the next tick must still run).
        this.logger.error(
          `alerts.recordTickResult threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return tick;
  }

  /** Test accessor for the most recent tick. */
  getLastTick(): OutboundTickResult | null {
    return this.lastTick;
  }
}

// PrismaClient re-export so consumers (tests) can type their fixtures
// without pulling a second import from @shadhil/database.
export type { PrismaClient };
