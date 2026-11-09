// Milestones Nest module (portal redesign, 2026-11-09). PrismaModule is @Global().
import { Module } from '@nestjs/common';

import { MilestonesController } from './milestones.controller';
import { MilestonesService } from './milestones.service';

@Module({
  controllers: [MilestonesController],
  providers: [MilestonesService],
})
export class MilestonesModule {}
