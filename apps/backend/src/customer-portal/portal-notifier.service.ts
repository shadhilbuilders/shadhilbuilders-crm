// PortalNotifier (issue #8 slice 2, spec D8): tell a buyer their unit has a
// new progress photo. BEST EFFORT: it runs after the photo row has committed,
// is never awaited by the upload, and catches + WARN-logs every failure - a
// push problem must never reach the staff member holding the phone.
//
// Identity: the recipient lookup runs under the named service context
// { userId: 'portal-notifier', role: 'CRON_SERVICE' } (AGENTS.md system-path
// exemption). CRON_SERVICE has no Booking/Lead read, so the lookup goes
// through the SECURITY DEFINER helper unit_customer_user_ids(), which applies
// the same APPROVED-booking rule as the read path. Delivery then happens per
// recipient under that recipient's own context (PushService.sendToUsers), so
// no service identity ever touches PushSubscription.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { withRlsContext } from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';
import { PushService } from '../push/push.service';

export const PORTAL_NOTIFIER_USER_ID = 'portal-notifier';

export interface NewPhotoNotice {
  organizationId: string;
  unitId: string;
  unitNumber: string;
  photoId: string;
  caption: string;
}

@Injectable()
export class PortalNotifier {
  private readonly logger = new Logger(PortalNotifier.name);

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(PushService) private readonly push: PushService,
  ) {}

  /** Never rejects. Resolves to the number of subscriptions attempted. */
  async notifyNewPhoto(notice: NewPhotoNotice): Promise<number> {
    try {
      const rows = await withRlsContext(
        this.prismaService.$client,
        {
          userId: PORTAL_NOTIFIER_USER_ID,
          role: 'CRON_SERVICE',
          organizationId: notice.organizationId,
        },
        (tx) =>
          tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT unit_customer_user_ids(${notice.unitId}) AS id`,
      );
      if (rows.length === 0) return 0;

      return await this.push.sendToUsers(
        notice.organizationId,
        rows.map((r) => r.id),
        {
          title: `New photos for ${notice.unitNumber}`,
          body: notice.caption,
          url: `/portal?photo=${encodeURIComponent(notice.photoId)}`,
          tag: `progress-${notice.unitId}`,
        },
        'CUSTOMER',
      );
    } catch (err) {
      this.logger.warn(
        `[portal-notifier] push for photo ${notice.photoId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }
}
