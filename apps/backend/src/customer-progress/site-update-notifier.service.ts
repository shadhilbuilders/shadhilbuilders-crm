// SiteUpdateNotifier (2026-11-08): tell the humans on the staff side that a
// site note landed.
//
// WHY THIS EXISTS: a note nobody reads is worse than no note, because it looks
// like the work is done. Before this, the only person told anything about a
// progress photo was the BUYER (PortalNotifier); no staff member was notified of
// anything at all, so the project's photo lead and the team managers had to
// remember to open a unit and look.
//
// BEST EFFORT, same posture as PortalNotifier: it runs AFTER the photo row has
// committed, is never awaited by the upload, never rejects, and logs its own
// failures. A notification fault must never reach the engineer holding the
// phone - and must never be confused with an upload failure.
//
// Identity for the RECIPIENT LOOKUP: the fixed service context
// { userId: 'site-update-notifier', role: 'CRON_SERVICE' }. Recipient resolution
// has to be visibility-independent - an engineer cannot read other people's
// ProjectStaffRole rows and Team reads are scoped to their own teams - so the
// lookup goes through the SECURITY DEFINER helper
// project_site_update_recipient_ids(). NotificationsService.emit() then writes
// each row under the RECIPIENT's own context, so the owner-only insert policy
// is satisfied without a new policy.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { withRlsContext } from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';

export const SITE_UPDATE_NOTIFIER_USER_ID = 'site-update-notifier';

/** The notification type. The inbox groups by PREFIX ('progress'), and the
 *  label map in the notifications page renders it as "Site photo". */
export const SITE_UPDATE_NOTIFICATION_TYPE = 'progress.photo';

export interface NewSitePhotoNotice {
  organizationId: string;
  projectId: string;
  unitId: string;
  unitNumber: string;
  photoId: string;
  caption: string;
  /** The uploader: skipped, you do not need telling about your own photo. */
  uploaderId: string;
  uploaderName: string | null;
}

/** Clamp a caption into a notification body. Long notes get an ellipsis rather
 *  than being cut mid-word with no signal that they were cut. */
export function clampBody(text: string, max = 120): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 3).trimEnd()}...`;
}

@Injectable()
export class SiteUpdateNotifier {
  private readonly logger = new Logger(SiteUpdateNotifier.name);

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  /** Never rejects. Resolves to the number of notifications emitted. */
  async notifyNewPhoto(notice: NewSitePhotoNotice): Promise<number> {
    try {
      const recipients = await withRlsContext(
        this.prismaService.$client,
        {
          userId: SITE_UPDATE_NOTIFIER_USER_ID,
          role: 'CRON_SERVICE',
          organizationId: notice.organizationId,
        },
        (tx) =>
          tx.$queryRaw<Array<{ id: string }>>`SELECT project_site_update_recipient_ids(${notice.projectId}) AS id`,
      );

      const targets = recipients
        .map((r) => r.id)
        .filter((id) => id !== notice.uploaderId);
      if (targets.length === 0) return 0;

      const body = clampBody(
        notice.uploaderName !== null && notice.uploaderName.length > 0
          ? `${notice.uploaderName}: ${notice.caption}`
          : notice.caption,
      );

      let sent = 0;
      for (const recipientId of targets) {
        try {
          await this.notifications.emit(recipientId, {
            type: SITE_UPDATE_NOTIFICATION_TYPE,
            title: `New site photo on ${notice.unitNumber}`,
            body,
            // Anchor to the unit so the inbox's active-project filter can see
            // it (a photo has no lead). Not a push deep link: PushService only
            // carries lead/booking ids, and inventing a unitId field there is
            // its own change.
            unitId: notice.unitId,
            organizationId: notice.organizationId,
          });
          sent += 1;
        } catch (err) {
          // One bouncing recipient must not stop the rest.
          this.logger.warn(
            `[site-update-notifier] emit for photo ${notice.photoId} to ${recipientId} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return sent;
    } catch (err) {
      this.logger.warn(
        `[site-update-notifier] notification for photo ${notice.photoId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }
}
