// Notifications module — in-app inbox + mark-as-read.
//
// T-NOTIF (2026-09-07): replaces the Phase-1 stub. NotificationsService
// exports itself so other modules (leads, visits, bookings, webhooks)
// can call .emit() to push events into the recipient's inbox.
//
// The page wiring (apps/web/src/hooks/queries/crm.ts) calls
// useNotifications / useMarkNotificationsRead — both light up
// against this module.
import { Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
