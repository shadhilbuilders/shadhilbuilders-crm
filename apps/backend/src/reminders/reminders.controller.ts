// Reminders controller - list endpoint. The cron processor lives in
// RemindersService.tick() and runs via @Cron('* * * * *') - the
// controller is read-only surface for clients to poll recent fires.
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  RemindersService,
  type ReminderListResult,
} from './reminders.service';

@ApiTags('reminders')
@ApiBearerAuth('jwt')
@Controller('reminders')
export class RemindersController {
  constructor(
    @Inject(RemindersService) private readonly reminders: RemindersService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List due + recent reminders (T-G4 surface). The cron processor is fire-and-forget; clients poll this to show "last fired" / "next due" in the UI.',
  })
  async list(): Promise<ReminderListResult> {
    return this.reminders.list();
  }
}
