// Reminders module — 4 reminder types + cron processor.
//
// Eng review A3: cron job is Redis-locked. The processor lives in
// reminders.processor.ts and runs every minute, picking up SCHEDULED
// reminders where scheduledFor <= NOW(). The Redis lock ensures only
// one NestJS replica processes each tick.
import { Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';

@ApiTags('reminders')
@ApiBearerAuth('jwt')
@Controller('reminders')
class RemindersController {
  @Public()
  @Get()
  list(): { message: string; phase: number } {
    return { message: 'Reminder cron lands in Week 7', phase: 1 };
  }
}

@Module({ controllers: [RemindersController] })
export class RemindersModule {}
