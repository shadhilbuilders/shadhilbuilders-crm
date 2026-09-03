// Leads module — Lead Inbox + state machine + creation flow.
// Wires the controller + service. LeadsService is exported so other
// modules (visits, chat, bookings) can call transition() on related
// state changes — when those modules land, this is the central choke
// point for ownership handoffs (DESIGN.md §3 Model C handoff).
import { Module } from '@nestjs/common';

import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  controllers: [LeadsController],
  providers: [LeadsService],
  exports: [LeadsService],
})
export class LeadsModule {}
