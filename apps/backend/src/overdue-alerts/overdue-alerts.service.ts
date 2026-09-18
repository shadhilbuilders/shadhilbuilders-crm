// Overdue-alerts service - the cron processor that nags owners, team
// managers, and org owners about NEW leads that have breached the
// time-to-first-touch SLA.
//
// T-OVERDUE-ALERTS (2026-09-18). THE "EVERY 1 HOUR UNTIL STATUS CHANGES"
// CONTRACT. A lead is overdue when state = NEW AND createdAt <= now - 30min
// (the exact predicate from leads.service.ts / lib/leads.ts, mirrored here).
// The cron runs every minute but only PUSHES a lead when its durable
// `lastOverduePushedAt` stamp is older than 1 hour (or still NULL) - so each
// lead is nagged at most once an hour while it stays overdue. Once the lead
// leaves NEW it stops matching the overdue query entirely, so the nags stop
// too - no extra bookkeeping for "until status changes".
//
// SAFETY SHELL (mirrors reminders.service.ts):
//   1. Redis lock (acquireLock/releaseLock + renewLease) - only one NestJS
//      replica processes each minute; the batch loop renews the lease at
//      half-life so a long cold-start batch doesn't lose the lock mid-run.
//   2. `lastOverduePushedAt = now` is written per lead AFTER the emits, so a
//      crashed run (lease lost but rows already emitted) at worst re-nags
//      those leads on the next tick - duplicate push, never a lost one.
//   3. All Prisma runs inside withRlsContext(CRON_SERVICE/cron-service) so
//      the lead_select_cron_service + lead_update_cron_service policies
//      match (see packages/database/prisma/rls/policies.sql).
//
// RECIPIENT RESOLUTION (per the owner's spec, clarified 2026-09-18):
//   - lead owner:  Lead.ownerId
//   - team manager: the manager of the team Lead.teamId belongs to (Team.managerId)
//   - org owner(s): every User with role = OWNER in Lead.organizationId
// Each recipient goes through NotificationsService.emit (writes an in-app
// inbox row AND fires a best-effort web push), deduped within a run so a
// manager-of-many-teams or an org-owner who is also the lead owner isn't
// spammed twice for the same lead.
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
  withRlsContext,
  type PrismaClient,
} from '@shadhil/database';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.module';
import { RedisService } from '../redis/redis.module';

export const OVERDUE_ALERT_LOCK_KEY = 'cron:overdue-alerts:lock';
const LOCK_TTL_SEC = 50; // cron fires every 60s - keep < 60
const LOCK_RENEWAL_SEC = 25; // renew at half-life
const OVERDUE_AFTER_MIN = 30; // time-to-first-touch SLA (lib/leads.ts)
const RE_PUSH_EVERY_MS = 60 * 60 * 1000; // every 1 hour

type OverdueLead = {
  id: string;
  name: string;
  ownerId: string;
  teamId: string;
  organizationId: string;
};

@Injectable()
export class OverdueAlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OverdueAlertsService.name);
  private readonly replicaId = randomUUID();
  private lastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTick: {
    startedAt: Date;
    finishedAt: Date | null;
    considered: number;
    pushed: number;
    lockHeld: boolean;
  } | null = null;

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService,
  ) {}

  static withReplicaId(
    prismaService: PrismaService,
    redis: RedisService,
    notifications: NotificationsService,
    replicaId: string,
  ): OverdueAlertsService {
    const svc = new OverdueAlertsService(
      prismaService,
      redis,
      notifications,
    );
    (svc as unknown as { replicaId: string }).replicaId = replicaId;
    return svc;
  }

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  onModuleInit(): void {
    this.logger.log(
      `OverdueAlertsService initialized, replicaId=${this.replicaId}`,
    );
  }

  onModuleDestroy(): void {
    if (this.lastTimer !== null) {
      clearTimeout(this.lastTimer);
      this.lastTimer = null;
    }
  }

  @Cron('* * * * *')
  async processOverdue(): Promise<void> {
    await this.tick();
  }

  /** Public wrapper around the cron body. Tests drive this directly. */
  async tick(): Promise<void> {
    const startedAt = new Date();
    const tick = {
      startedAt,
      finishedAt: null as Date | null,
      considered: 0,
      pushed: 0,
      lockHeld: false,
    };
    this.lastTick = tick;

    const acquired = await this.redis.acquireLock(
      OVERDUE_ALERT_LOCK_KEY,
      LOCK_TTL_SEC,
      this.replicaId,
    );
    if (!acquired) {
      this.logger.debug(
        `Skipping tick - another replica holds ${OVERDUE_ALERT_LOCK_KEY}`,
      );
      tick.finishedAt = new Date();
      return;
    }
    tick.lockHeld = true;

    const renewTimer = setInterval(() => {
      void this.redis
        .renewLease(OVERDUE_ALERT_LOCK_KEY, this.replicaId, LOCK_TTL_SEC)
        .catch((err: unknown) => {
          this.logger.error(
            `Lease renewal error: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }, LOCK_RENEWAL_SEC * 1000);

    try {
      const orgId = process.env['PUBLIC_ORG_ID'] ?? '';
      const cronCtx = {
        userId: 'cron-service',
        role: 'CRON_SERVICE' as const,
        organizationId: orgId,
      };

      // Overdue = NEW + created more than 30min ago AND last nagged more
      // than 1h ago (or never). Prisma cannot express `lastOverduePushedAt
      // IS NULL OR <= cutoff` as a plain where on an optional field directly
      // with an OR across the same column cleanly inside findMany, so we
      // query NEW+overdue-within-window plus separately handle NULL.
      const cutoff = new Date(Date.now() - RE_PUSH_EVERY_MS);
      const overdueCutoff = new Date(Date.now() - OVERDUE_AFTER_MIN * 60_000);

      const [cronLeadsQueried, neverPushedQueried] = await Promise.all([
        // Run these two scans IN PARALLEL, each in its OWN withRlsContext
        // transaction. @prisma/adapter-pg pins ONE pooled pg client per
        // transaction, so concurrent `.query()` calls inside a SINGLE
        // transaction hit the same client (pg deprecation, interleave risk).
        // Separate transactions use separate pooled connections - parallel
        // AND warning-free.
        withRlsContext(this.client, cronCtx, (tx) =>
          (tx as unknown as PrismaClient).lead.findMany({
            where: {
              state: 'NEW',
              createdAt: { lte: overdueCutoff },
              lastOverduePushedAt: { lte: cutoff },
            },
            select: {
              id: true,
              name: true,
              ownerId: true,
              teamId: true,
              organizationId: true,
            },
            take: 100,
          }),
        ),
        withRlsContext(this.client, cronCtx, (tx) =>
          (tx as unknown as PrismaClient).lead.findMany({
            where: {
              state: 'NEW',
              createdAt: { lte: overdueCutoff },
              lastOverduePushedAt: null,
            },
            select: {
              id: true,
              name: true,
              ownerId: true,
              teamId: true,
              organizationId: true,
            },
            take: 100,
          }),
        ),
      ]);

      const cronLeads = cronLeadsQueried as unknown as OverdueLead[];
      const neverPushed = neverPushedQueried as unknown as OverdueLead[];

      const byId = new Map<string, OverdueLead>();
      for (const l of [...cronLeads, ...neverPushed]) {
        byId.set(l.id, l);
      }
      tick.considered = byId.size;

      if (byId.size === 0) {
        tick.finishedAt = new Date();
        return;
      }

      // Resolve recipients + emit per lead, then stamp lastOverduePushedAt.
      for (const lead of byId.values()) {
        try {
          const recipients = await this.resolveRecipients(
            cronCtx,
            lead.ownerId,
            lead.teamId,
            lead.organizationId,
          );
          for (const sub of recipients) {
            await this.notifications.emit(sub, {
              type: 'lead.overdue',
              title: `Lead overdue: ${lead.name}`,
              body: 'Still NEW and unanswered past the 30-minute first-touch SLA.',
              leadId: lead.id,
            });
          }
          // Stamp after the emits - a crash between emit and stamp re-nags
          // on the next tick (duplicate, never a lost alert).
          await withRlsContext(
            this.client,
            cronCtx,
            async (tx) =>
              (tx as unknown as PrismaClient).lead.update({
                where: { id: lead.id },
                data: { lastOverduePushedAt: new Date() },
              }),
          );
          tick.pushed += recipients.length;
        } catch (err) {
          this.logger.error(
            `Overdue alert failed for lead ${lead.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      clearInterval(renewTimer);
      await this.redis.releaseLock(OVERDUE_ALERT_LOCK_KEY, this.replicaId);
      tick.finishedAt = new Date();
    }
  }

  /**
   * Resolve the deduplicated recipient set for a lead:
   * owner, team manager, and every org OWNER. Returns userIds.
   */
  private async resolveRecipients(
    cronCtx: { userId: string; role: 'CRON_SERVICE'; organizationId: string },
    ownerId: string,
    teamId: string,
    organizationId: string,
  ): Promise<string[]> {
    type Rows = {
      managerId?: string | null;
      owners: Array<{ id: string }>;
    };
    const r = await withRlsContext(this.client, cronCtx, async (tx) => {
      const p = tx as unknown as PrismaClient;
      const team = await p.team.findUnique({
        where: { id: teamId },
        select: { managerId: true },
      });
      const owners = await p.user.findMany({
        where: { role: 'OWNER', organizationId },
        select: { id: true },
      });
      return { managerId: team?.managerId ?? null, owners } as Rows;
    });

    const set = new Set<string>([ownerId]);
    if (r.managerId) set.add(r.managerId);
    for (const o of r.owners) set.add(o.id);
    return [...set];
  }

  /** Test-only accessor. */
  getLastTick(): typeof this.lastTick {
    return this.lastTick;
  }
}
