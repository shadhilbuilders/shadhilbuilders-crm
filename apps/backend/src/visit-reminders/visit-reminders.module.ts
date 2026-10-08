// Wires the visit-reminder cron (T-VISIT-REMINDER). Notifications/Redis are @Global().
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';

import { VisitRemindersService } from './visit-reminders.service';

@Module({
  imports: [PrismaModule],
  providers: [VisitRemindersService],
  exports: [VisitRemindersService],
})
export class VisitRemindersModule {}
