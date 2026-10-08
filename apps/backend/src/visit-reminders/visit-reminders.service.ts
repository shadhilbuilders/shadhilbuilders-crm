// Visit reminders - the cron that tells the people involved a site visit is
// coming up (T-VISIT-REMINDER, 2026-10-09).
//
// WHEN: `Organization.visitReminderLeadMinutes` before `scheduledFor` (default 60,
// configurable per org via PATCH /api/organization/settings).
// WHO: exec, lead owner, lead's team manager, org owner(s) - the SAME audience as
// the "visit scheduled" notification (`resolveVisitStakeholders`).
// ONCE: `SiteVisit.reminderSentAt` is claimed with a conditional update BEFORE
// sending, so two replicas (or a lost Redis lock) cannot double-send. If every
// emit fails the claim is released so the next tick retries; a partial failure
// keeps the claim (some people already got it - a duplicate would be worse).
// A rescheduled visit is a NEW row, so it gets its own reminder.
//
// Safety shell mirrors overdue-alerts: Redis lock + lease renewal, per-org
// CRON_SERVICE contexts (forEachOrganization), in-process overlap guard,
// 100 visits/tick/org cap, bounded emit concurrency.
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';

import { formatVisitWhen } from '../leads/lead-activity';
import { withRlsContext, type PrismaClient } from '@shadhil/database';

import { forEachOrganization } from '../common/cron-orgs';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.module';
import { RedisService } from '../redis/redis.module';
import { resolveVisitStakeholders } from '../visits/visit-recipients';

export const VISIT_REMINDER_LOCK_KEY = 'cron:visit-reminders:lock';
const LOCK_TTL_SEC = 50;
const LOCK_RENEWAL_SEC = 25;
const PER_ORG_BATCH = 100;
const EMIT_CONCURRENCY = 10;

type DueVisit = {
  id: string;
  leadId: string;
  userId: string;
  organizationId: string;
  scheduledFor: Date;
  lead: { name: string };
};

@Injectable()
export class VisitRemindersService implements OnModuleDestroy {
  private readonly logger = new Logger(VisitRemindersService.name);
  private readonly replicaId = randomUUID();
  private cronRunning = false;
  private renewTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  onModuleDestroy(): void {
    if (this.renewTimer !== null) clearInterval(this.renewTimer);
  }

  @Cron('* * * * *')
  async processDue(): Promise<void> {
    if (this.cronRunning) {
      this.logger.warn('Previous visit-reminder tick still running - skipping');
      return;
    }
    this.cronRunning = true;
    try {
      await this.tick();
    } finally {
      this.cronRunning = false;
    }
  }

  /** Returns the number of reminders sent. Tests drive this directly. */
  async tick(now: Date = new Date()): Promise<number> {
    const acquired = await this.redis.acquireLock(
      VISIT_REMINDER_LOCK_KEY,
      LOCK_TTL_SEC,
      this.replicaId,
    );
    if (!acquired) return 0;

    this.renewTimer = setInterval(() => {
      void this.redis
        .renewLease(VISIT_REMINDER_LOCK_KEY, this.replicaId, LOCK_TTL_SEC)
        .catch((err: unknown) =>
          this.logger.error(
            `Lease renewal error: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }, LOCK_RENEWAL_SEC * 1000);

    let sent = 0;
    try {
      await forEachOrganization(this.client, this.logger, 'Visit reminders', async (ctx) => {
        const due = await withRlsContext(this.client, ctx, async (tx) => {
          const db = tx as unknown as PrismaClient;
          const org = await db.organization.findUnique({
            where: { id: ctx.organizationId },
            select: { visitReminderLeadMinutes: true },
          });
          if (org === null) return [] as DueVisit[];
          const horizon = new Date(now.getTime() + org.visitReminderLeadMinutes * 60_000);
          return (await db.siteVisit.findMany({
            where: {
              status: 'SCHEDULED',
              reminderSentAt: null,
              scheduledFor: { gt: now, lte: horizon },
            },
            orderBy: { scheduledFor: 'asc' },
            take: PER_ORG_BATCH,
            select: {
              id: true,
              leadId: true,
              userId: true,
              organizationId: true,
              scheduledFor: true,
              lead: { select: { name: true } },
            },
          })) as DueVisit[];
        });
        for (const visit of due) {
          try {
            if (await this.remind(ctx, visit, now)) sent += 1;
          } catch (err) {
            this.logger.error(
              `Visit reminder failed for visit ${visit.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      });
    } finally {
      if (this.renewTimer !== null) clearInterval(this.renewTimer);
      this.renewTimer = null;
      await this.redis.releaseLock(VISIT_REMINDER_LOCK_KEY, this.replicaId);
    }
    return sent;
  }

  /** Claim, notify, and release the claim only if nobody could be told. */
  private async remind(
    ctx: { userId: string; role: 'CRON_SERVICE'; organizationId: string },
    visit: DueVisit,
    now: Date,
  ): Promise<boolean> {
    const claimed = await withRlsContext(this.client, ctx, async (tx) =>
      (tx as unknown as PrismaClient).siteVisit.updateMany({
        where: { id: visit.id, reminderSentAt: null, status: 'SCHEDULED' },
        data: { reminderSentAt: now },
      }),
    );
    if (claimed.count !== 1) return false; // another replica won, or visit closed

    const audience = await resolveVisitStakeholders(this.client, {
      organizationId: visit.organizationId,
      leadId: visit.leadId,
      assigneeId: visit.userId,
    });
    const payload = {
      type: 'visit.reminder',
      title: `Visit reminder: ${visit.lead.name}`,
      body: `Site visit at ${formatVisitWhen(visit.scheduledFor)}.`,
      leadId: visit.leadId,
      organizationId: visit.organizationId,
    };

    let delivered = 0;
    for (let i = 0; i < audience.length; i += EMIT_CONCURRENCY) {
      const results = await Promise.allSettled(
        audience.slice(i, i + EMIT_CONCURRENCY).map((sub) => this.notifications.emit(sub, payload)),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') delivered += 1;
        else this.logger.error(`Reminder emit failed for visit ${visit.id}: ${String(r.reason)}`);
      }
    }

    if (delivered === 0) {
      // Nobody was told: release the claim so the next tick retries.
      await withRlsContext(this.client, ctx, async (tx) =>
        (tx as unknown as PrismaClient).siteVisit.updateMany({
          where: { id: visit.id },
          data: { reminderSentAt: null },
        }),
      );
      return false;
    }
    return true;
  }
}
