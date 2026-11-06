// Leads module - Lead Inbox + state machine + creation flow.
// Wires the controller + service. LeadsService is exported so other
// modules (visits, chat, bookings) can call transition() on related
// state changes - when those modules land, this is the central choke
// point for ownership handoffs (DESIGN.md §3 Model C handoff).
import { Module } from '@nestjs/common';

import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadFactsController } from './lead-facts.controller';
import { LeadFactsService } from './lead-facts.service';

@Module({
  controllers: [LeadsController, LeadFactsController],
  providers: [LeadsService, LeadFactsService],
  exports: [LeadsService, LeadFactsService],
})
export class LeadsModule {}
