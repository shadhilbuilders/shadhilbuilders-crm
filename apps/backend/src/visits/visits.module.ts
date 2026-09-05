// Visits module - site-visit scheduling, outcomes, and reschedule.
//
// VisitsService depends on LeadsService for the lead state handoff
// (e.g. scheduling a visit auto-advances Lead VISIT_REQUESTED →
// VISIT_SCHEDULED; recording COMPLETED drives Lead → VISITED). We
// import LeadsModule so DI can resolve the dependency.
import { Module } from '@nestjs/common';

import { LeadsModule } from '../leads/leads.module';

import { VisitsController } from './visits.controller';
import { VisitsService } from './visits.service';

@Module({
  imports: [LeadsModule],
  controllers: [VisitsController],
  providers: [VisitsService],
  exports: [VisitsService],
})
export class VisitsModule {}
