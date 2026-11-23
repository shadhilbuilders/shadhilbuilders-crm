// Leads module - Lead Inbox + state machine + creation flow.
// Wires the controller + service. LeadsService is exported so other
// modules (visits, chat, bookings) can call transition() on related
// state changes - when those modules land, this is the central choke
// point for ownership handoffs (DESIGN.md §3 Model C handoff).
import { Module } from '@nestjs/common';

import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadConsentController } from './lead-consent.controller';
import { LeadConsentService } from './lead-consent.service';
import { LeadFactsController } from './lead-facts.controller';
import { LeadFactsService } from './lead-facts.service';

@Module({
  controllers: [LeadsController, LeadFactsController, LeadConsentController],
  providers: [LeadsService, LeadFactsService, LeadConsentService],
  exports: [LeadsService, LeadFactsService, LeadConsentService],
})
export class LeadsModule {}
