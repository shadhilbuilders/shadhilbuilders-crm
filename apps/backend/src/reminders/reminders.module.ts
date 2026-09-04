// Reminders module — wires the cron processor + Redis lease + Prisma.
// T-G4: the cron fires every minute; Redis lock prevents duplicate
// fires across replicas; status-claim (updateMany SCHEDULED →
// PROCESSING) is the second-line idempotency primitive.
//
// The ScheduleModule.forRoot() in main.ts enables @Cron decorators
// globally; this module just registers the service.
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';

import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';

@Module({
  imports: [PrismaModule],
  controllers: [RemindersController],
  providers: [RemindersService],
  exports: [RemindersService],
})
export class RemindersModule {}
