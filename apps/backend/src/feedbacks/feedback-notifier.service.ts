// FeedbackNotifier (2026-11-21): tell the admin class that new feedback landed.
//
// WHY THIS EXISTS: a public submission writes a Feedback row and returns 200.
// Before this, nobody was told. The row sat in the ADMIN/OWNER-only triage page
// (`/{orgSlug}/admin/feedback`) until somebody happened to open it, so a 1-star
// review could sit unanswered for days - the exact failure a feedback form is
// supposed to prevent.
//
// RECIPIENTS: every live ADMIN and OWNER of the submitting org. OWNER travels as
// ADMIN at the RLS layer but is still a distinct row here, so both roles are
// listed explicitly. Soft-deleted accounts are never notified.
//
// Identity for the RECIPIENT LOOKUP: the fixed service context
// { userId: 'feedback-notifier', role: 'CRON_SERVICE' }. The submit path runs as
// PUBLIC_API, which has INSERT-only power on Feedback and cannot read User rows
// to find an audience - resolving recipients therefore has to happen under a
// service identity, exactly like SiteUpdateNotifier / PortalNotifier.
// NotificationsService.emit() then writes each row under the RECIPIENT's own
// context, so the owner-only insert policy is satisfied without a new policy.
//
// BEST EFFORT, same posture as SiteUpdateNotifier: it runs AFTER the feedback row
// has committed, is never awaited by the submit response, never rejects, and logs
// its own failures. A notification fault must never turn a successful feedback
// submission into an error the visitor sees.
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { withRlsContext, type PrismaClient } from '@shadhil/database';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.module';

export const FEEDBACK_NOTIFIER_USER_ID = 'feedback-notifier';

/** The notification type. The inbox links it to the admin feedback page and the
 *  label map renders it as "New feedback". */
export const FEEDBACK_CREATED_NOTIFICATION_TYPE = 'feedback.created';

export interface NewFeedbackNotice {
  organizationId: string;
  feedbackId: string;
  rating: number;
  name: string | null;
  project: string | null;
  message: string | null;
}

/** Clamp free text into a notification body without cutting mid-word with no
 *  signal that it was cut. Mirrors SiteUpdateNotifier.clampBody. */
export function clampFeedbackBody(text: string, max = 140): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 3).trimEnd()}...`;
}

/**
 * Title + body for the notification row.
 *
 * Pure and exported so the copy is pinned by a test: this is the only thing the
 * admin sees in the bell popover before deciding whether to open the inbox.
 */
export function feedbackNotificationCopy(notice: {
  rating: number;
  name: string | null;
  project: string | null;
  message: string | null;
}): { title: string; body: string } {
  const who =
    notice.name !== null && notice.name.trim().length > 0 ? notice.name.trim() : 'Anonymous';
  const project =
    notice.project !== null && notice.project.trim().length > 0
      ? ` · ${notice.project.trim()}`
      : '';
  const message =
    notice.message !== null && notice.message.trim().length > 0
      ? `: ${clampFeedbackBody(notice.message)}`
      : '';

  return {
    title: `New ${notice.rating}/5 feedback`,
    body: `${who}${project}${message}`,
  };
}

@Injectable()
export class FeedbackNotifier {
  private readonly logger = new Logger(FeedbackNotifier.name);

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    // @Optional() (rule 7h): the notification dep is best-effort. Test factories
    // that build this service with one arg stay green; production DI resolves it
    // through the @Global() NotificationsModule.
    @Optional()
    @Inject(NotificationsService)
    private readonly notifications?: NotificationsService,
  ) {}

  /** Never rejects. Resolves to the number of notifications emitted. */
  async notifyNewFeedback(notice: NewFeedbackNotice): Promise<number> {
    if (this.notifications === undefined) return 0;
    try {
      const { recipients, orgSlug } = await withRlsContext(
        this.prismaService.$client,
        {
          userId: FEEDBACK_NOTIFIER_USER_ID,
          role: 'CRON_SERVICE',
          organizationId: notice.organizationId,
        },
        async (tx) => {
          const db = tx as unknown as PrismaClient;
          // Sequential, not Promise.all: @prisma/adapter-pg pins ONE pooled
          // client per transaction, so concurrent queries on one tx trip pg's
          // "client.query() while already executing" path (pg@9 will throw).
          const admins = await db.user.findMany({
            where: {
              organizationId: notice.organizationId,
              role: { in: ['ADMIN', 'OWNER'] },
              deletedAt: null,
            },
            select: { id: true },
          });
          const org = await db.organization.findUnique({
            where: { id: notice.organizationId },
            select: { slug: true },
          });
          return {
            recipients: admins.map((u: { id: string }) => u.id),
            orgSlug: org?.slug ?? null,
          };
        },
      );

      if (recipients.length === 0) return 0;

      const copy = feedbackNotificationCopy(notice);
      // Org-level deep link: feedback has no lead and no unit, so there is no
      // project anchor to resolve. The triage page is org-scoped
      // (`/{orgSlug}/admin/feedback`), which is also where notificationHref
      // sends an in-app click.
      const href = orgSlug !== null ? `/${orgSlug}/admin/feedback` : undefined;

      let sent = 0;
      for (const recipientId of recipients) {
        try {
          await this.notifications.emit(recipientId, {
            type: FEEDBACK_CREATED_NOTIFICATION_TYPE,
            title: copy.title,
            body: copy.body,
            organizationId: notice.organizationId,
            ...(href !== undefined ? { href } : {}),
          });
          sent += 1;
        } catch (err) {
          // One bouncing recipient must not stop the rest.
          this.logger.warn(
            `[feedback-notifier] emit for feedback ${notice.feedbackId} to ${recipientId} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return sent;
    } catch (err) {
      this.logger.warn(
        `[feedback-notifier] notification for feedback ${notice.feedbackId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }
}
