// Dashboard module - one aggregate endpoint for the project work dashboard.
//
// DashboardService depends only on PrismaService (no cross-module import),
// so this module imports nothing but the global PrismaModule. The role
// scoping (managerTeamId lookup) is mirrored from leads/visits - the same
// pattern visits.service.ts uses to avoid a circular module import.
import { Module } from '@nestjs/common';

import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
