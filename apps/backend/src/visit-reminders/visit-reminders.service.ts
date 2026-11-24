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

import { checkinStillWorthSending } from '../visits/checkin-schedule';
import { greetingName } from '../customer-progress/site-update-greeting';
import { OutboundService, VISIT_CHECKIN_TEMPLATE } from '../whatsapp/outbound.service';

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

type DueCheckin = {
  id: string;
  leadId: string;
  userId: string;
  organizationId: string;
  checkinDueAt: Date | null;
  lead: {
    name: string | null;
    phoneE164: string | null;
    phone: string | null;
    projectId: string | null;
  };
};

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
    @Inject(OutboundService) private readonly outbound: OutboundService,
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

        // Quiet hours (2026-11-24): check-ins owed by completed visits are sent
        // here, not from the request that recorded the outcome, so a 22:30
        // completion waits for 08:00. Same lock, same lease, same per-row
        // isolation as the reminders above.
        try {
          const queued = await this.sweepCheckins(ctx, now);
          if (queued > 0) this.logger.log(`Check-ins queued: ${queued}`);
        } catch (err) {
          this.logger.error(
            `Check-in sweep failed for ${ctx.organizationId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    } finally {
      if (this.renewTimer !== null) clearInterval(this.renewTimer);
      this.renewTimer = null;
      await this.redis.releaseLock(VISIT_REMINDER_LOCK_KEY, this.replicaId);
    }
    return sent;
  }

  /**
   * Send the check-in a completed visit has owed since `checkinDueAt`.
   *
   * The claim is the once-only stamp: a conditional update that only succeeds for
   * the tick that got there first. Everything after it (the thread row, the outbox
   * row) is the consequence of winning that claim.
   */
  private async sweepCheckins(
    ctx: { userId: string; role: 'CRON_SERVICE'; organizationId: string },
    now: Date,
  ): Promise<number> {
    const due = (await withRlsContext(this.client, ctx, async (tx) =>
      (tx as unknown as PrismaClient).siteVisit.findMany({
        where: {
          status: 'COMPLETED',
          checkinQueuedAt: null,
          checkinDueAt: { not: null, lte: now },
        },
        orderBy: { checkinDueAt: 'asc' },
        take: PER_ORG_BATCH,
        select: {
          id: true,
          leadId: true,
          userId: true,
          organizationId: true,
          checkinDueAt: true,
          lead: {
            select: { name: true, phoneE164: true, phone: true, projectId: true },
          },
        },
      }),
    )) as DueCheckin[];

    let queued = 0;
    for (const visit of due) {
      try {
        if (await this.sendCheckin(ctx, visit, now)) queued += 1;
      } catch (err) {
        this.logger.error(
          `Check-in failed for visit ${visit.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return queued;
  }

  /** Queue one check-in. Returns false when this tick decided not to send. */
  private async sendCheckin(
    ctx: { userId: string; role: 'CRON_SERVICE'; organizationId: string },
    visit: DueCheckin,
    now: Date,
  ): Promise<boolean> {
    const claim = async (): Promise<boolean> =>
      withRlsContext(this.client, ctx, async (tx) => {
        const result = await (tx as unknown as PrismaClient).siteVisit.updateMany({
          where: { id: visit.id, checkinQueuedAt: null },
          data: { checkinQueuedAt: now },
        });
        return result.count === 1;
      });

    // A check-in the cron could not send for two days never arrives. Claiming it
    // anyway is what keeps a dead row out of every future scan.
    if (visit.checkinDueAt === null || !checkinStillWorthSending(visit.checkinDueAt, now)) {
      if (await claim()) {
        this.logger.warn(
          `Check-in for visit ${visit.id} dropped: due ${visit.checkinDueAt?.toISOString() ?? 'never'}, more than 48h late`,
        );
      }
      return false;
    }

    if (!(await claim())) return false;

    const phone = visit.lead.phoneE164 ?? visit.lead.phone;
    if (phone === null || phone.length === 0) {
      this.logger.warn(
        `Check-in for visit ${visit.id} not sent: lead ${visit.leadId} has no WhatsApp number`,
      );
      return false;
    }

    try {
      await withRlsContext(this.client, ctx, async (tx) => {
        const db = tx as unknown as PrismaClient;
        const project =
          visit.lead.projectId === null
            ? null
            : await db.project.findUnique({
                where: { id: visit.lead.projectId },
                select: { name: true },
              });

        // Raw INSERT, no RETURNING. Message has INSERT policies for CRON_SERVICE
        // but no SELECT arm, so a typed `message.create()` fails on the read-back
        // that Prisma always appends (42501). The webhook's inbound path writes its
        // rows the same way. The id is derived from the visit, so a retried
        // transaction collides instead of writing a second row.
        const messageId = `visit_checkin_${visit.id}`;
        await db.$executeRawUnsafe(
          `INSERT INTO "Message" (id, "organizationId", "leadId", "userId", direction, channel, kind, body, "createdAt")
           VALUES ($1, $2, $3, $4, 'OUT', 'WHATSAPP', 'CUSTOMER', $5, NOW())`,
          messageId,
          visit.organizationId,
          visit.leadId,
          // The exec who recorded the outcome: the column is a non-null FK, and a
          // system author would be a schema change across the thread.
          visit.userId,
          `Site visit check-in sent (${VISIT_CHECKIN_TEMPLATE}).`,
        );

        await this.outbound.enqueue(
          {
            messageId,
            organizationId: visit.organizationId,
            leadId: visit.leadId,
            sendType: 'TEMPLATE',
            templateName: VISIT_CHECKIN_TEMPLATE,
            // {{1}} the first name, {{2}} the site the visit was for.
            templateVars: {
              '1': greetingName(visit.lead.name),
              '2': project?.name ?? 'your site visit',
            },
          },
          tx as unknown as Parameters<OutboundService['enqueue']>[1],
        );
      });
      return true;
    } catch (err) {
      // Release the claim so the next tick retries: nothing reached the outbox.
      await withRlsContext(this.client, ctx, async (tx) => {
        await (tx as unknown as PrismaClient).siteVisit.updateMany({
          where: { id: visit.id },
          data: { checkinQueuedAt: null },
        });
      });
      throw err;
    }
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
