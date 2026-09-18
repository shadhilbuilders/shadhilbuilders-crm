// Overdue-alerts module - wires the cron processor.
// T-OVERDUE-ALERTS (2026-09-18): the @Cron fires every minute; Redis lock
// prevents duplicate fires; lastOverduePushedAt is the durable every-1-hour
// dedupe. Consumes Notifications/Redis (both @Global()).
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';

import { OverdueAlertsService } from './overdue-alerts.service';

@Module({
  imports: [PrismaModule],
  providers: [OverdueAlertsService],
  exports: [OverdueAlertsService],
})
export class OverdueAlertsModule {}
